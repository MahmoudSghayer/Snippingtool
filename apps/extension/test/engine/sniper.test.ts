// The Sniping Bot loop (`engine/sniper.ts`): search -> buy under the price
// cap, pacing (delay, breaks, rests), the user's thresholds, and the stops the
// user cannot turn off (kill switch, adapter probe failure, governor limits).
// A fake adapter and a fake clock stand in for EA's app and for real time:
// `sleep` advances the clock instantly.

import {
  DEFAULT_BOT_SETTINGS,
  DEFAULT_GOVERNOR_SETTINGS,
  type BotSettings,
  type GovernorSettings,
  type TrimmedAuction,
} from '@sl/shared';
import { describe, expect, it, vi } from 'vitest';

import { Sniper, type SniperDeps, type SniperFilter } from '../../src/engine/sniper.js';

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
  buys: string[];
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
  sellPrice?: number | null;
  /** Stop the bot after this many searches (at the wait that follows). */
  maxSearches?: number;
  /** The user's governor settings (recommended mode's caps). */
  governor?: GovernorSettings | null;
}): Harness {
  // Ratio 1 so a buy on the very first search is allowed; the ratio itself
  // is the governor's concern and is covered in governor.test.ts.
  // Custom limits (acknowledged) unless a test says otherwise, so the pacing
  // tests below see the user's own numbers; the "safety mode" block covers
  // recommended mode.
  const settings: BotSettings = {
    ...DEFAULT_BOT_SETTINGS,
    safetyMode: 'custom',
    customRiskAcknowledgedAt: '2026-09-24T00:00:00.000Z',
    safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1 },
    ...opts.settings,
  };
  const clock = { t: 1_000_000 };
  const auctionsListeners = new Set<(a: unknown[]) => void>();
  const probeListeners = new Set<
    (s: { ok: boolean; checkedAt: number; reason?: string }) => void
  >();
  const searches: unknown[] = [];
  const buys: string[] = [];
  const waits: { phase: string; ms: number }[] = [];
  const killSwitch = { active: false };
  const results = opts.results ?? [[]];
  let finished!: () => void;
  const finishedPromise = new Promise<void>((r) => (finished = r));

  const deps: SniperDeps = {
    adapter: {
      search: async (filter) => {
        searches.push(filter);
        const batch = results[Math.min(searches.length - 1, results.length - 1)]!;
        for (const cb of auctionsListeners) cb(batch);
        return { ok: true, latencyMs: 5 };
      },
      buy: async (tradeId) => {
        buys.push(tradeId);
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
    getGovernorSettings: () => (opts.governor === undefined ? DEFAULT_GOVERNOR_SETTINGS : opts.governor),
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
    buys,
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
          actionsPerHour: 2,
          cooldownSeconds: 600,
        },
      },
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    const blocked = h.waits.find((w) => w.phase === 'blocked');
    expect(blocked!.ms).toBe(600_000);
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

describe('Sniper — safety mode', () => {
  const fast = {
    searchDelay: { min: 0.5, max: 1 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
    // A stored value far above the recommended caps (a tampered storage.local).
    safety: {
      actionsPerHour: 7_200,
      sessionLengthMinutes: 1_440,
      buyToSearchRatio: 1,
      cooldownSeconds: 0,
      maxCoinFlowPerHour: 1_000_000_000,
    },
  } satisfies Partial<BotSettings>;

  it('recommended mode clamps a tampered stored value to the governor caps', async () => {
    const h = setup({
      settings: { ...fast, safetyMode: 'recommended', customRiskAcknowledgedAt: null },
      maxSearches: 2,
    });
    h.sniper.start();
    const limits = h.sniper.getGovernor()!.getSettings();
    expect(limits).toEqual({
      actionsPerHour: DEFAULT_GOVERNOR_SETTINGS.actionsPerHour,
      sessionLengthMinutes: DEFAULT_GOVERNOR_SETTINGS.sessionLengthMinutes,
      buyToSearchRatio: DEFAULT_GOVERNOR_SETTINGS.buyToSearchRatio,
      cooldownSeconds: DEFAULT_GOVERNOR_SETTINGS.cooldownSeconds,
      maxCoinFlowPerHour: DEFAULT_GOVERNOR_SETTINGS.maxCoinFlowPerHour,
    });
    await h.done();
    // The 0.5 s delay is raised so searches (and the buys they may bring)
    // fit in 30 actions an hour: 3600 * 1.35 / 30 = 162 s.
    const waits = h.waits.filter((w) => w.phase === 'waiting');
    expect(waits.length).toBeGreaterThan(0);
    for (const w of waits) expect(w.ms).toBeGreaterThanOrEqual(162_000);
  });

  it('recommended mode never goes past GOVERNOR_ABSOLUTE_LIMITS, even with a tampered governor cache', () => {
    const h = setup({
      settings: { ...fast, safetyMode: 'recommended', customRiskAcknowledgedAt: null },
      governor: {
        actionsPerHour: 100_000,
        sessionLengthMinutes: 100_000,
        buyToSearchRatio: 5,
        cooldownSeconds: -5,
        maxCoinFlowPerHour: 1e12,
      },
    });
    h.sniper.start();
    expect(h.sniper.getGovernor()!.getSettings()).toEqual({
      actionsPerHour: 120,
      sessionLengthMinutes: 240,
      buyToSearchRatio: 1,
      cooldownSeconds: 0,
      maxCoinFlowPerHour: 5_000_000,
    });
    h.sniper.stop();
  });

  it('recommended mode paces searches so the actions-per-hour cap is never hit', async () => {
    const h = setup({
      settings: { ...fast, safetyMode: 'recommended', customRiskAcknowledgedAt: null },
      governor: { ...DEFAULT_GOVERNOR_SETTINGS, actionsPerHour: 2, cooldownSeconds: 600 },
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    expect(h.searches).toHaveLength(3);
    // 3600 * 1.35 / 2 = 2430 s between searches, so the governor never
    // has to refuse one.
    expect(h.waits.some((w) => w.phase === 'blocked')).toBe(false);
    for (const w of h.waits.filter((x) => x.phase === 'waiting'))
      expect(w.ms).toBeGreaterThanOrEqual(2_430_000);
  });

  it('custom mode at the same speed runs into the governor instead', async () => {
    const h = setup({
      settings: {
        ...fast,
        safety: { ...fast.safety, actionsPerHour: 2, cooldownSeconds: 600 },
      },
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    expect(h.waits.some((w) => w.phase === 'blocked')).toBe(true);
  });

  it('custom mode without an acknowledgment runs as recommended', () => {
    const h = setup({
      settings: { ...fast, safetyMode: 'custom', customRiskAcknowledgedAt: null },
    });
    h.sniper.start();
    expect(h.sniper.getEffectiveSettings().mode).toBe('recommended');
    expect(h.sniper.getGovernor()!.getSettings().actionsPerHour).toBe(30);
    h.sniper.stop();
  });

  it('acknowledged custom mode applies the user limits up to BOT_LIMITS', async () => {
    const h = setup({ settings: { ...fast }, maxSearches: 2 });
    h.sniper.start();
    expect(h.sniper.getEffectiveSettings().mode).toBe('custom');
    expect(h.sniper.getGovernor()!.getSettings().actionsPerHour).toBe(7_200);
    await h.done();
    expect(h.waits.filter((w) => w.phase === 'waiting')[0]!.ms).toBe(500);
  });

  it('switching back to recommended tightens a running bot at once', () => {
    const h = setup({ settings: { ...fast } });
    h.sniper.start();
    h.sniper.setSettings({
      ...DEFAULT_BOT_SETTINGS,
      ...fast,
      safetyMode: 'recommended',
      customRiskAcknowledgedAt: null,
    });
    expect(h.sniper.getGovernor()!.getSettings().actionsPerHour).toBe(30);
    h.sniper.stop();
  });

  it('the kill switch and a probe failure still stop the bot in custom mode', async () => {
    const k = setup({ settings: { ...fast }, results: [[auction('t-a', 8_000)]] });
    k.killSwitch.active = true;
    k.sniper.start();
    await k.done();
    expect(k.searches).toHaveLength(0);
    expect(k.sniper.state.stopReason).toBe('kill_switch');

    const p = setup({ settings: { ...fast } });
    p.sniper.start();
    p.probe(false);
    expect(p.sniper.state.stopReason).toBe('probe_failure');
  });
});
