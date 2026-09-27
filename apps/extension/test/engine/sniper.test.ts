// The Sniping Bot loop (`engine/sniper.ts`): search -> buy under the price
// cap, pacing (delay, breaks, rests), the user's thresholds, and the stops the
// user cannot turn off (kill switch, adapter probe failure, governor limits).
// A fake adapter and a fake clock stand in for EA's app and for real time:
// `sleep` advances the clock instantly.

import {
  BOT_LIMITS,
  DEFAULT_BOT_SETTINGS,
  type BotBudgetState,
  type BotDailyUsage,
  type BotSettings,
  type TrimmedAuction,
} from '@sl/shared';
import { describe, expect, it, vi } from 'vitest';

import { Sniper, type SniperDeps, type SniperFilter } from '../../src/engine/sniper.js';
import { ACT_ERROR } from '../../src/lib/act-auth.js';

import type { ActionOutcome } from '../../src/content/adapter-client.js';

function auction(
  tradeId: string,
  buyNow: number,
  extra: Partial<TrimmedAuction> = {},
): TrimmedAuction {
  return {
    tradeId,
    resourceId: 100,
    assetId: 100,
    rating: 85,
    buyNow,
    startingBid: 0,
    currentBid: 0,
    offers: 0,
    expiresAt: null,
    seenAt: 0,
    ...extra,
  };
}

interface Harness {
  sniper: Sniper;
  clock: { t: number };
  searches: unknown[];
  /** Clock time of each search. */
  searchTimes: number[];
  savedUsage: BotDailyUsage[];
  buys: string[];
  /** The card each buy named (`adapter.buy`'s third argument). */
  buyCards: unknown[];
  waits: { phase: string; ms: number }[];
  killSwitch: { active: boolean };
  probe: (ok: boolean) => void;
  done: () => Promise<void>;
}

function setup(opts: {
  settings?: Partial<BotSettings>;
  filters?: SniperFilter[];
  /** Auctions each successive search returns (last one repeats). */
  results?: TrimmedAuction[][];
  buyOk?: (tradeId: string) => boolean;
  /** The adapter's whole answer to a buy, when a test needs more than ok. */
  buyResult?: (tradeId: string) => ActionOutcome;
  sellPrice?: number | null;
  /** Stop the bot after this many searches (at the wait that follows). */
  maxSearches?: number;
  /** Today's active time as an earlier page saved it. */
  usage?: BotDailyUsage | null;
  /** Where the hourly budgets are saved (share one to simulate a reload). */
  budgetStore?: { value: BotBudgetState | null };
  /** Whether the plan includes the bot, asked before every action. */
  entitled?: () => boolean;
  /** The clock's start (to continue another harness's clock). */
  startAt?: number;
}): Harness {
  // Ratio 1 so a buy on the very first search is allowed; the ratio itself
  // is the governor's concern and is covered in governor.test.ts. No
  // cooldown after a buy, unless a test sets one. The risk is acknowledged,
  // so the pacing tests can use fast delays; the "limits" block covers the
  // unacknowledged case.
  const settings: BotSettings = {
    ...DEFAULT_BOT_SETTINGS,
    riskAcknowledgedAt: '2026-09-24T00:00:00.000Z',
    safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1, cooldownSeconds: 0 },
    ...opts.settings,
  };
  const clock = { t: opts.startAt ?? 1_000_000 };
  const auctionsListeners = new Set<(a: TrimmedAuction[]) => void>();
  const probeListeners = new Set<
    (s: { ok: boolean; checkedAt: number; reason?: string }) => void
  >();
  const searches: unknown[] = [];
  const searchTimes: number[] = [];
  const savedUsage: BotDailyUsage[] = [];
  const buys: string[] = [];
  const buyCards: unknown[] = [];
  const waits: { phase: string; ms: number }[] = [];
  const killSwitch = { active: false };
  const results = opts.results ?? [[]];
  let finished!: () => void;
  const finishedPromise = new Promise<void>((r) => (finished = r));

  const deps: SniperDeps = {
    adapter: {
      search: async (filter) => {
        searches.push(filter);
        searchTimes.push(clock.t);
        const batch = results[Math.min(searches.length - 1, results.length - 1)]!;
        for (const cb of auctionsListeners) cb(batch);
        return { ok: true, latencyMs: 5 };
      },
      buy: async (tradeId, _price, card) => {
        buys.push(tradeId);
        buyCards.push(card);
        if (opts.buyResult) return opts.buyResult(tradeId);
        const ok = opts.buyOk ? opts.buyOk(tradeId) : true;
        return ok ? { ok: true, latencyMs: 5 } : { ok: false, error: 'item sold', latencyMs: 5 };
      },
      onAuctions: (cb) => {
        auctionsListeners.add(cb);
        return () => auctionsListeners.delete(cb);
      },
      onProbe: (cb) => {
        probeListeners.add(cb);
        return () => probeListeners.delete(cb);
      },
      onShape: () => () => undefined,
    },
    getFilters: () =>
      opts.filters ?? [{ id: 'f1', name: 'Target', filter: { resourceId: 100, maxPrice: 10_000 } }],
    estimateSellPrice: async () => (opts.sellPrice === undefined ? 20_000 : opts.sellPrice),
    loadUsage: async () => opts.usage ?? null,
    saveUsage: (u) => void savedUsage.push(u),
    ...(opts.budgetStore
      ? {
          loadBudget: async () => opts.budgetStore!.value,
          saveBudget: (b: BotBudgetState) => void (opts.budgetStore!.value = structuredClone(b)),
        }
      : {}),
    ...(opts.entitled ? { entitled: opts.entitled } : {}),
    killSwitch: () => ({
      active: killSwitch.active,
      reason: killSwitch.active ? 'test kill switch' : undefined,
    }),
    onChange: () => {
      if (sniper.state.phase === 'stopped') finished();
    },
    now: () => clock.t,
    random: () => 0,
    sleep: async (ms) => {
      waits.push({ phase: sniper.state.phase, ms });
      clock.t += ms;
      // Stop at the first wait after the last wanted search, so that
      // search's buys have all run.
      if (
        opts.maxSearches != null &&
        searches.length >= opts.maxSearches &&
        sniper.state.phase === 'waiting'
      )
        sniper.stop('manual');
      await Promise.resolve();
    },
  };
  const sniper = new Sniper(deps, settings);
  return {
    sniper,
    clock,
    searches,
    searchTimes,
    savedUsage,
    buys,
    buyCards,
    waits,
    killSwitch,
    probe: (ok) =>
      probeListeners.forEach((cb) =>
        cb({ ok, checkedAt: 0, reason: ok ? undefined : 'services missing' }),
      ),
    done: () => finishedPromise,
  };
}

describe('Sniper — search and buy', () => {
  it('buys listings at or under the price cap, cheapest first, and skips the rest', async () => {
    const h = setup({
      // An empty first search keeps two buys within the buy/search ratio of 1.
      results: [
        [],
        [
          auction('t-expensive', 12_000),
          auction('t-b', 9_000),
          auction('t-a', 8_000),
          auction('t-other', 5_000, { resourceId: 999, assetId: 999 }),
        ],
      ],
      maxSearches: 2,
    });
    h.sniper.start();
    await h.done();

    expect(h.buys).toEqual(['t-a', 't-b']);
    const stats = h.sniper.getStats();
    expect(stats.purchases).toBe(2);
    expect(stats.coinsSpent).toBe(17_000);
    // 20,000 resale minus 5% tax = 19,000; profits 11,000 + 10,000
    expect(stats.profit).toBe(21_000);
    expect(stats.topSnipes.map((e) => e.profit)).toEqual([11_000, 10_000]);
    expect(h.sniper.getSearchResults()[0]!.matches.map((m) => m.tradeId)).toEqual(['t-a', 't-b']);
  });

  it('buys a special version of the target player (same base id, different resourceId)', async () => {
    const h = setup({
      results: [[auction('t-special', 9_000, { resourceId: 50_331_748, assetId: 100 })]],
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-special']);
    expect(h.sniper.getLog().find((e) => e.kind === 'bought')?.assetId).toBe(100);
  });

  it('searches with the lower of the filter max price and the page max buy price', async () => {
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, maxBuyPrice: 7_000 } },
      results: [[auction('t-a', 8_000), auction('t-b', 6_500)]],
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]).toMatchObject({ maxPrice: 7_000 });
    expect(h.buys).toEqual(['t-b']);
  });

  it('skips a listing whose known profit is below the minimum, but buys unknown-profit ones', async () => {
    const low = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 15_000 } },
      results: [[auction('t-a', 8_000)]],
      maxSearches: 1,
    });
    low.sniper.start();
    await low.done();
    expect(low.buys).toEqual([]);

    const unknown = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 15_000 } },
      results: [[auction('t-a', 8_000)]],
      sellPrice: null,
      maxSearches: 1,
    });
    unknown.sniper.start();
    await unknown.done();
    expect(unknown.buys).toEqual(['t-a']);
  });

  it('counts failed buys and keeps going', async () => {
    const h = setup({
      results: [[], [auction('t-a', 8_000), auction('t-b', 9_000)]],
      buyOk: (id) => id === 't-b',
      maxSearches: 2,
    });
    h.sniper.start();
    await h.done();
    expect(h.sniper.getStats()).toMatchObject({ purchases: 1, failures: 1 });
  });
});

describe('Sniper — pacing', () => {
  it('waits the search delay between searches and breaks after N searches', async () => {
    const h = setup({
      settings: {
        searchDelay: { min: 2, max: 4 },
        breaks: { enabled: true, searches: { min: 2, max: 2 }, seconds: { min: 30, max: 30 } },
        rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
      },
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    // random() = 0 -> the low end of each range
    expect(h.waits.map((w) => `${w.phase}:${w.ms}`)).toEqual([
      'waiting:2000',
      'waiting:2000',
      'break:30000',
      'waiting:2000',
    ]);
  });

  it('rests once the rest interval has passed', async () => {
    const h = setup({
      settings: {
        searchDelay: { min: 60, max: 60 },
        breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
        rest: { enabled: true, afterMinutes: { min: 2, max: 2 }, minutes: { min: 5, max: 5 } },
      },
      maxSearches: 4,
    });
    h.sniper.start();
    await h.done();
    expect(h.waits.map((w) => w.phase)).toEqual([
      'waiting',
      'waiting',
      'rest',
      'waiting',
      'waiting',
    ]);
    expect(h.waits.find((w) => w.phase === 'rest')!.ms).toBe(5 * 60_000);
  });

  it('pauses when the safety limits refuse a search instead of spinning', async () => {
    const h = setup({
      settings: {
        searchDelay: { min: 1, max: 1 },
        breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
        rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
        safety: {
          ...DEFAULT_BOT_SETTINGS.safety,
          buyToSearchRatio: 1,
          maxSearchesPerHour: 2,
          cooldownSeconds: 0,
        },
      },
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    const blocked = h.waits.find((w) => w.phase === 'blocked');
    // Two searches, 1 s delay each; the third waits until the first is an hour old.
    expect(blocked!.ms).toBe(3_600_000 - 2_000);
    expect(h.sniper.getLog().some((e) => e.kind === 'blocked')).toBe(true);
  });
});

describe('Sniper — stops', () => {
  it('refuses to start with no filters', () => {
    const h = setup({ filters: [] });
    h.sniper.start();
    expect(h.sniper.isRunning()).toBe(false);
    expect(h.sniper.state.stopReason).toBe('no_filters');
  });

  it('stops after the purchase limit', async () => {
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, stopAfterPurchases: 1 } },
      results: [[auction('t-a', 8_000), auction('t-b', 9_000)]],
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a']);
    expect(h.sniper.state.stopReason).toBe('purchase_limit');
  });

  it('stops once the coin budget is spent', async () => {
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, sessionCoinBudget: 8_000 } },
      results: [[auction('t-a', 8_000), auction('t-b', 9_000)]],
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a']);
    expect(h.sniper.state.stopReason).toBe('coin_budget');
  });

  it('stops on the server kill switch before acting', async () => {
    const h = setup({ results: [[auction('t-a', 8_000)]] });
    h.killSwitch.active = true;
    h.sniper.start();
    await h.done();
    expect(h.searches).toHaveLength(0);
    expect(h.sniper.state.stopReason).toBe('kill_switch');
  });

  it('stops when the adapter probe fails', () => {
    const h = setup({});
    h.sniper.start();
    h.probe(false);
    expect(h.sniper.isRunning()).toBe(false);
    expect(h.sniper.state.stopReason).toBe('probe_failure');
  });

  it('stops by hand at once and can be reset', async () => {
    const h = setup({});
    const onChange = vi.fn();
    h.sniper.start();
    h.sniper.stop();
    expect(h.sniper.state.stopReason).toBe('manual');
    h.sniper.reset();
    expect(h.sniper.getStats().searches).toBe(0);
    expect(h.sniper.getLog()).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Sniper — the user\'s limits', () => {
  const quick = {
    searchDelay: { min: 1, max: 1 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
  } satisfies Partial<BotSettings>;
  const safety = (patch: Partial<BotSettings['safety']>): BotSettings['safety'] => ({
    ...DEFAULT_BOT_SETTINGS.safety,
    buyToSearchRatio: 1,
    cooldownSeconds: 0,
    ...patch,
  });

  it('keeps searches inside max searches per hour', async () => {
    const h = setup({
      settings: { ...quick, safety: safety({ maxSearchesPerHour: 3 }) },
      maxSearches: 4,
    });
    h.sniper.start();
    await h.done();
    const [first, , third, fourth] = h.searchTimes;
    expect(third! - first!).toBeLessThan(3_600_000);
    expect(fourth! - first!).toBeGreaterThanOrEqual(3_600_000);
    expect(h.sniper.getLog().some((e) => e.message.includes('3 searches in the last hour'))).toBe(
      true,
    );
  });

  it('keeps buys inside max buys per hour', async () => {
    const h = setup({
      settings: { ...quick, safety: safety({ maxBuysPerHour: 2 }) },
      results: [[auction('t-a', 7_000)], [auction('t-b', 8_000)], [auction('t-c', 9_000)]],
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    expect(h.searches).toHaveLength(3);
    expect(h.buys).toEqual(['t-a', 't-b']);
    expect(h.sniper.getLog().some((e) => e.message.startsWith('Buy skipped'))).toBe(true);
  });

  it('waits the cooldown after every buy', async () => {
    const h = setup({
      settings: { ...quick, safety: safety({ cooldownSeconds: 10 }) },
      results: [[auction('t-a', 7_000)], [auction('t-b', 8_000)]],
      maxSearches: 2,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a', 't-b']);
    expect(h.waits.filter((w) => w.phase === 'cooldown').map((w) => w.ms)).toEqual([
      10_000, 10_000,
    ]);
  });

  it('stops at max active hours per day, not counting rests', async () => {
    const h = setup({
      settings: {
        searchDelay: { min: 600, max: 600 },
        breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
        rest: { enabled: true, afterMinutes: { min: 30, max: 30 }, minutes: { min: 45, max: 45 } },
        safety: safety({ maxActiveHoursPerDay: 1 }),
      },
    });
    const startedAt = h.clock.t;
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('daily_limit');
    // An hour of 10-minute gaps, with one 45-minute rest in between.
    expect(h.searches).toHaveLength(6);
    expect(h.waits.filter((w) => w.phase === 'rest')).toHaveLength(1);
    expect(h.clock.t - startedAt).toBe(60 * 60_000 + 45 * 60_000);
    expect(h.savedUsage.at(-1)!.activeMs).toBe(3_600_000);
  });

  it('counts active time an earlier page already used today', async () => {
    const day = new Date(1_000_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    const h = setup({
      settings: {
        ...quick,
        searchDelay: { min: 600, max: 600 },
        safety: safety({ maxActiveHoursPerDay: 1 }),
      },
      usage: { day: today, activeMs: 50 * 60_000 },
    });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('daily_limit');
    expect(h.searches).toHaveLength(1);
  });

  it('clamps a tampered stored value outside BOT_LIMITS', async () => {
    const tampered = {
      ...quick,
      searchDelay: { min: 0, max: 0 },
      safety: safety({ maxSearchesPerHour: 1e9, maxBuysPerHour: 1e9, maxActiveHoursPerDay: 500 }),
    } as Partial<BotSettings>;
    const h = setup({ settings: tampered, maxSearches: 2 });
    h.sniper.start();
    const eff = h.sniper.getEffectiveSettings();
    expect(eff.safety.maxSearchesPerHour).toBe(BOT_LIMITS.maxSearchesPerHour.max);
    expect(eff.safety.maxBuysPerHour).toBe(BOT_LIMITS.maxBuysPerHour.max);
    expect(eff.safety.maxActiveHoursPerDay).toBe(24);
    expect(h.sniper.getGovernor()!.getSettings().actionsPerHour).toBe(
      BOT_LIMITS.maxSearchesPerHour.max + BOT_LIMITS.maxBuysPerHour.max,
    );
    await h.done();
    expect(h.waits.filter((w) => w.phase === 'waiting')[0]!.ms).toBe(
      BOT_LIMITS.searchDelaySeconds.min * 1000,
    );
  });

  it('will not start settings above low risk until the risk is acknowledged', () => {
    const risky = setup({
      settings: { ...quick, riskAcknowledgedAt: null },
    });
    risky.sniper.start();
    expect(risky.sniper.isRunning()).toBe(false);
    expect(risky.sniper.state.stopReason).toBe('risk_unacknowledged');

    // The recommended defaults are low: no acknowledgment needed.
    const safe = setup({ settings: { ...DEFAULT_BOT_SETTINGS, riskAcknowledgedAt: null } });
    safe.sniper.start();
    expect(safe.sniper.isRunning()).toBe(true);
    safe.sniper.stop();
  });

  it('rates every limit: 1e9 coins an hour with no acknowledgment does not start', () => {
    const h = setup({
      settings: {
        ...DEFAULT_BOT_SETTINGS,
        riskAcknowledgedAt: null,
        safety: { ...DEFAULT_BOT_SETTINGS.safety, maxCoinFlowPerHour: 1_000_000_000 },
      },
    });
    h.sniper.start();
    expect(h.sniper.isRunning()).toBe(false);
    expect(h.sniper.state.stopReason).toBe('risk_unacknowledged');
    expect(h.searches).toHaveLength(0);

    // Likewise a cooldown of 0, or a buy on every search.
    for (const patch of [{ cooldownSeconds: 0 }, { buyToSearchRatio: 1 }]) {
      const other = setup({
        settings: {
          ...DEFAULT_BOT_SETTINGS,
          riskAcknowledgedAt: null,
          safety: { ...DEFAULT_BOT_SETTINGS.safety, ...patch },
        },
      });
      other.sniper.start();
      expect(other.sniper.state.stopReason).toBe('risk_unacknowledged');
    }

    // Acknowledged, the user may raise it (up to BOT_LIMITS).
    const acked = setup({
      settings: {
        ...DEFAULT_BOT_SETTINGS,
        riskAcknowledgedAt: '2026-09-24T00:00:00.000Z',
        safety: { ...DEFAULT_BOT_SETTINGS.safety, maxCoinFlowPerHour: 1_000_000_000 },
      },
    });
    acked.sniper.start();
    expect(acked.sniper.isRunning()).toBe(true);
    expect(acked.sniper.getGovernor()!.getSettings().maxCoinFlowPerHour).toBe(1_000_000_000);
    acked.sniper.stop();
  });

  it('stops when settings are raised above low while running, without an acknowledgment', () => {
    const h = setup({ settings: { ...DEFAULT_BOT_SETTINGS, riskAcknowledgedAt: null } });
    h.sniper.start();
    expect(h.sniper.isRunning()).toBe(true);
    h.sniper.setSettings({
      ...DEFAULT_BOT_SETTINGS,
      riskAcknowledgedAt: null,
      safety: { ...DEFAULT_BOT_SETTINGS.safety, maxCoinFlowPerHour: 1_000_000_000 },
    });
    expect(h.sniper.isRunning()).toBe(false);
    expect(h.sniper.state.stopReason).toBe('risk_unacknowledged');
  });

  it('the kill switch and a probe failure still stop the bot on any settings', async () => {
    const k = setup({ settings: { ...quick }, results: [[auction('t-a', 8_000)]] });
    k.killSwitch.active = true;
    k.sniper.start();
    await k.done();
    expect(k.searches).toHaveLength(0);
    expect(k.sniper.state.stopReason).toBe('kill_switch');

    const p = setup({ settings: { ...quick } });
    p.sniper.start();
    p.probe(false);
    expect(p.sniper.state.stopReason).toBe('probe_failure');
  });
});

describe('Sniper — the adapter\'s answers (lib/act-auth.ts)', () => {
  it('skips a listing the adapter says it cannot buy', async () => {
    const h = setup({ results: [[auction('t-no', 8_000, { buyable: false }), auction('t-yes', 9_000, { buyable: true })]], maxSearches: 1 });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-yes']);
  });

  it('records a buy EA confirmed only after the adapter stopped waiting', async () => {
    let settleLate!: (o: ActionOutcome) => void;
    const late = new Promise<ActionOutcome>((r) => (settleLate = r));
    const h = setup({
      results: [[auction('t-slow', 8_000)]],
      maxSearches: 1,
      buyResult: () => ({ ok: false, error: ACT_ERROR.timeoutUnknown, signed: true, latencyMs: 15_000, late }),
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-slow']);
    expect(h.sniper.getStats().purchases).toBe(0);
    settleLate({ ok: true, signed: true, latencyMs: 20_000 });
    await vi.waitFor(() => expect(h.sniper.getStats().purchases).toBe(1));
    expect(h.sniper.getStats().coinsSpent).toBe(8_000);
  });

  it('gives a signed refusal back to the hourly buy limit; an unsigned one stays charged', async () => {
    const run = async (signed: boolean) => {
      const h = setup({
        settings: { safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1, cooldownSeconds: 0, maxBuysPerHour: 1 } },
        results: [[auction('t-refused', 8_000), auction('t-next', 9_000)]],
        maxSearches: 1,
        buyResult: (tradeId) =>
          tradeId === 't-refused'
            ? { ok: false, error: ACT_ERROR.priceMismatch, ...(signed ? { signed: true as const } : {}), latencyMs: 1 }
            : { ok: true, signed: true, latencyMs: 1 },
      });
      h.sniper.start();
      await h.done();
      return h.buys;
    };
    expect(await run(true)).toEqual(['t-refused', 't-next']);
    expect(await run(false)).toEqual(['t-refused']);
  });
});

describe('Sniper — hourly budgets survive Stop/Start and a page reload', () => {
  const settings = (patch: Partial<BotSettings['safety']>): Partial<BotSettings> => ({
    searchDelay: { min: 1, max: 1 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
    safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1, cooldownSeconds: 0, ...patch },
  });

  it('Stop then Start does not refill the searches-per-hour window or the governor', async () => {
    const budgetStore = { value: null as BotBudgetState | null };
    const h = setup({ settings: settings({ maxSearchesPerHour: 3 }), maxSearches: 3, budgetStore });
    h.sniper.start();
    await h.done();
    expect(h.searches).toHaveLength(3);
    const actions = h.sniper.getGovernor()!.snapshot().actionsLastHour;
    expect(actions).toBe(3);

    // Start again straight away: the fourth search still waits for the
    // first to leave the one-hour window.
    const stopped = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!h.sniper.isRunning()) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });
    h.sniper.start();
    expect(h.sniper.getGovernor()!.snapshot().actionsLastHour).toBe(3);
    await stopped;
    expect(h.searches).toHaveLength(4);
    expect(h.searchTimes[3]! - h.searchTimes[0]!).toBeGreaterThanOrEqual(3_600_000);
    expect(h.sniper.getLog().some((e) => e.message.includes('3 searches in the last hour'))).toBe(
      true,
    );
    expect(budgetStore.value!.searchTimes.length).toBeGreaterThan(0);
  });

  it('a new page (a reload) picks the saved budgets up: searches, buys and coins', async () => {
    const budgetStore = { value: null as BotBudgetState | null };
    const first = setup({
      settings: settings({ maxSearchesPerHour: 3, maxCoinFlowPerHour: 20_000 }),
      results: [[auction('t-a', 9_000)], [auction('t-b', 9_000)], []],
      maxSearches: 3,
      budgetStore,
    });
    first.sniper.start();
    await first.done();
    expect(first.buys).toEqual(['t-a', 't-b']);
    expect(budgetStore.value!.searchTimes).toHaveLength(3);
    expect(budgetStore.value!.buyTimes).toHaveLength(2);
    expect(budgetStore.value!.governor.coinFlow.map((c) => c.coins)).toEqual([9_000, 9_000]);

    // The reloaded page: a new Sniper, the same storage, the same clock.
    const second = setup({
      settings: settings({ maxSearchesPerHour: 3, maxCoinFlowPerHour: 20_000 }),
      results: [[auction('t-c', 9_000)]],
      maxSearches: 1,
      budgetStore,
      startAt: first.clock.t,
    });
    second.sniper.start();
    await second.done();
    // Its first search waited for the saved window to free up...
    expect(second.searchTimes[0]! - first.searchTimes[0]!).toBeGreaterThanOrEqual(3_600_000);
    // ...and by then the saved coin flow had drained too, so it could buy.
    expect(second.buys).toEqual(['t-c']);
  });

  it('a reload inside the hour keeps the coin flow spent', async () => {
    const budgetStore = { value: null as BotBudgetState | null };
    const first = setup({
      settings: settings({ maxCoinFlowPerHour: 10_000 }),
      results: [[auction('t-a', 9_000)]],
      maxSearches: 1,
      budgetStore,
    });
    first.sniper.start();
    await first.done();
    expect(first.buys).toEqual(['t-a']);

    const second = setup({
      settings: settings({ maxCoinFlowPerHour: 10_000 }),
      results: [[auction('t-b', 9_000)]],
      maxSearches: 1,
      budgetStore,
      startAt: first.clock.t,
    });
    second.sniper.start();
    await second.done();
    expect(second.buys).toEqual([]);
    expect(second.sniper.getLog().some((e) => e.message.includes('coin flow'))).toBe(true);
  });
});

describe('Sniper — a Stop before the saved budget loads', () => {
  it('leaves the saved budget alone instead of saving an empty one over it', async () => {
    const start = 10_000_000;
    const saved: BotBudgetState = {
      governor: {
        sessionStartedAt: start - 60_000,
        actionTimestamps: [start - 60_000],
        searchCount: 1,
        buyCount: 0,
        coinFlow: [],
        cooldownUntil: 0,
        killSwitchActive: false,
      },
      searchTimes: [start - 60_000],
      buyTimes: [],
    };
    const budgetStore = { value: saved as BotBudgetState | null };
    const h = setup({ maxSearches: 1, budgetStore, startAt: start });
    h.sniper.start();
    h.sniper.stop('manual'); // before run() has awaited loadBudget
    await new Promise((r) => setTimeout(r, 0));
    expect(budgetStore.value).toBe(saved);
  });
});

describe('Sniper — the buy:search ratio does not bank a long history', () => {
  it('starts its counts over once the last hour holds no action', async () => {
    const start = 10_000_000;
    const budgetStore = {
      value: {
        governor: {
          sessionStartedAt: 0,
          actionTimestamps: [start - 2 * 3_600_000],
          searchCount: 1_000,
          buyCount: 0,
          coinFlow: [],
          cooldownUntil: 0,
          killSwitchActive: false,
        },
        searchTimes: [start - 2 * 3_600_000],
        buyTimes: [],
      } as BotBudgetState | null,
    };
    const h = setup({ maxSearches: 1, budgetStore, startAt: start });
    h.sniper.start();
    await h.done();
    expect(budgetStore.value!.governor.searchCount).toBe(1);
  });
});

describe('Sniper — the plan must still include the bot', () => {
  it('stops with a reason when the entitlement loses the bot mid-session', async () => {
    // The plan loses the bot after the second search (a heartbeat refreshed
    // the entitlement without `automation.autobuyer`).
    let searchesSoFar = () => 0;
    const h = setup({
      settings: {
        searchDelay: { min: 1, max: 1 },
        breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
        rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
      },
      results: [[], [auction('t-a', 8_000)]],
      entitled: () => searchesSoFar() < 2,
    });
    searchesSoFar = () => h.searches.length;
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('not_entitled');
    expect(h.sniper.state.stopDetail).toBe('your plan no longer includes the Sniping Bot');
    // Checked before the buy the second search found, not only the next search.
    expect(h.searches).toHaveLength(2);
    expect(h.buys).toEqual([]);
  });

  it('will not start without it', () => {
    const h = setup({ entitled: () => false });
    h.sniper.start();
    expect(h.sniper.isRunning()).toBe(false);
    expect(h.sniper.state.stopReason).toBe('not_entitled');
  });
});

describe('Sniper — binds each buy to the matched card', () => {
  it("names the listing's resourceId and assetId, so the adapter can check them", async () => {
    const h = setup({
      results: [[auction('t-special', 9_000, { resourceId: 50_331_748, assetId: 100 })]],
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    expect(h.buyCards).toEqual([{ resourceId: 50_331_748, assetId: 100 }]);
  });
});
