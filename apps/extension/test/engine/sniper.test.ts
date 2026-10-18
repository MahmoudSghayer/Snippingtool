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

import {
  Sniper,
  missOutcome,
  missReason,
  plannedSalePrice,
  searchMaxBuy,
  type SniperDeps,
  type SniperFilter,
} from '../../src/engine/sniper.js';
import { attemptErrorCode, attemptTiming, type AttemptInput } from '../../src/engine/types.js';
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
  /** Each auto-sell listing: [tradeId, startPrice, buyNowPrice]. */
  lists: [string, number, number][];
  /** Each sleep: the phase, how long, and the page's notice meanwhile. */
  waits: { phase: string; ms: number; notice: string | null }[];
  killSwitch: { active: boolean };
  probe: (ok: boolean) => void;
  done: () => Promise<void>;
}

function setup(opts: {
  settings?: Partial<BotSettings>;
  filters?: SniperFilter[];
  /** Auctions each successive search returns (last one repeats). */
  results?: TrimmedAuction[][];
  /** TradeIds the adapter upgrades to buyable during each successive
   * search, after its auctions (last one repeats). */
  upgrades?: string[][];
  buyOk?: (tradeId: string) => boolean;
  /** The adapter's whole answer to a buy, when a test needs more than ok. */
  buyResult?: (tradeId: string) => ActionOutcome;
  sellPrice?: number | null;
  /** What the bot's sleep says it is timed with. */
  timingMode?: () => 'worker' | 'page';
  /** How long each search takes EA to answer, on the test clock. */
  searchTakesMs?: number;
  /** How long after its listings the search's own answer comes back (the
   * clock moves on as soon as the listings are out). */
  answerLagMs?: number;
  /** Holds the `n`th search's own answer (1 first) back until it settles;
   * that search's upgrades (`upgrades`) come with the answer. */
  holdAnswer?: (n: number) => Promise<void> | undefined;
  /** Replaces the fixed `sellPrice` lookup. */
  estimateSellPrice?: (resourceId: number) => Promise<number | null>;
  /** Auto-sell's market price (FUTBIN, else Nova). Omitted = none. */
  marketPrice?: SniperDeps['marketPrice'];
  /** The adapter's answer to a listing. Default: ok. */
  listResult?: (tradeId: string) => ActionOutcome;
  /** Stop the bot after this many searches (at the wait that follows). */
  maxSearches?: number;
  /** Today's active time as an earlier page saved it. */
  usage?: BotDailyUsage | null;
  /** Where the hourly budgets are saved (share one to simulate a reload). */
  budgetStore?: { value: BotBudgetState | null };
  /** Whether the plan includes the bot, asked before every action. */
  entitled?: () => boolean;
  /** Replaces the budget store's load (a service worker that died). */
  loadBudget?: () => Promise<BotBudgetState | null>;
  /** Whether this tab holds the engine lease, asked before every action. */
  exclusive?: () => boolean;
  /** The clock's start (to continue another harness's clock). */
  startAt?: number;
  /** Each attempt the bot reports (telemetry `sniping`). */
  onAttempt?: SniperDeps['onAttempt'];
  /** Each risk event the bot reports (telemetry `riskEvents`). */
  onRiskEvent?: SniperDeps['onRiskEvent'];
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
  const buyableListeners = new Set<(tradeIds: string[]) => void>();
  const probeListeners = new Set<
    (s: { ok: boolean; checkedAt: number; reason?: string }) => void
  >();
  const searches: unknown[] = [];
  const searchTimes: number[] = [];
  const savedUsage: BotDailyUsage[] = [];
  const buys: string[] = [];
  const buyCards: unknown[] = [];
  const lists: [string, number, number][] = [];
  const waits: { phase: string; ms: number; notice: string | null }[] = [];
  const killSwitch = { active: false };
  const results = opts.results ?? [[]];
  let finished!: () => void;
  const finishedPromise = new Promise<void>((r) => (finished = r));

  const deps: SniperDeps = {
    adapter: {
      search: async (filter) => {
        searches.push(filter);
        searchTimes.push(clock.t);
        clock.t += opts.searchTakesMs ?? 0;
        const batch = results[Math.min(searches.length - 1, results.length - 1)]!;
        for (const cb of auctionsListeners) cb(batch);
        const n = searches.length;
        clock.t += opts.answerLagMs ?? 0;
        const held = opts.holdAnswer?.(n);
        if (held) await held;
        if (opts.upgrades) {
          const ids = opts.upgrades[Math.min(n - 1, opts.upgrades.length - 1)]!;
          for (const cb of buyableListeners) cb(ids);
        }
        return { ok: true, latencyMs: 5 };
      },
      buy: async (tradeId, _price, card) => {
        buys.push(tradeId);
        buyCards.push(card);
        if (opts.buyResult) return opts.buyResult(tradeId);
        const ok = opts.buyOk ? opts.buyOk(tradeId) : true;
        return ok ? { ok: true, latencyMs: 5 } : { ok: false, error: 'item sold', latencyMs: 5 };
      },
      list: async (tradeId, start, bin) => {
        lists.push([tradeId, start, bin]);
        return opts.listResult ? opts.listResult(tradeId) : { ok: true, latencyMs: 5 };
      },
      onAuctions: (cb) => {
        auctionsListeners.add(cb);
        return () => auctionsListeners.delete(cb);
      },
      onBuyable: (cb) => {
        buyableListeners.add(cb);
        return () => buyableListeners.delete(cb);
      },
      onProbe: (cb) => {
        probeListeners.add(cb);
        return () => probeListeners.delete(cb);
      },
      onShape: () => () => undefined,
    },
    getFilters: () =>
      opts.filters ?? [{ id: 'f1', name: 'Target', filter: { resourceId: 100, maxPrice: 10_000 } }],
    estimateSellPrice:
      opts.estimateSellPrice ?? (async () => (opts.sellPrice === undefined ? 20_000 : opts.sellPrice)),
    loadUsage: async () => opts.usage ?? null,
    saveUsage: (u) => void savedUsage.push(u),
    ...(opts.budgetStore
      ? {
          loadBudget: opts.loadBudget ?? (async () => structuredClone(opts.budgetStore!.value)),
          saveBudget: (b: BotBudgetState) => void (opts.budgetStore!.value = structuredClone(b)),
        }
      : {}),
    ...(opts.marketPrice ? { marketPrice: opts.marketPrice } : {}),
    ...(opts.timingMode ? { timingMode: opts.timingMode } : {}),
    ...(opts.entitled ? { entitled: opts.entitled } : {}),
    ...(opts.exclusive ? { exclusive: opts.exclusive } : {}),
    ...(opts.onAttempt ? { onAttempt: opts.onAttempt } : {}),
    ...(opts.onRiskEvent ? { onRiskEvent: opts.onRiskEvent } : {}),
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
      waits.push({ phase: sniper.state.phase, ms, notice: sniper.state.notice });
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
    lists,
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

  it("records what EA's answer held, so a search without a match says whether anything was listed", async () => {
    const h = setup({
      results: [[], [auction('t-other', 5_000, { resourceId: 999, assetId: 999 }), auction('t-dear', 12_000)]],
      maxSearches: 2,
    });
    h.sniper.start();
    await h.done();
    const [second, first] = h.sniper.getSearchResults();
    expect(first).toMatchObject({ matches: [], listings: 0, cheapest: null });
    expect(second).toMatchObject({ matches: [], listings: 2, cheapest: 5_000 });
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

  it('asks EA something new every search: the max buy-now price steps down the grid, the rest stays as set', async () => {
    const h = setup({
      filters: [{ id: 'f1', name: 'Target', filter: { resourceId: 100, maxPrice: 2_200, minRating: 84 } }],
      results: [[], [], []],
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    // Never a min price: the cheapest listings are in every search.
    expect(h.searches).toEqual([
      { resourceId: 100, maxPrice: 2_200, minRating: 84 },
      { resourceId: 100, maxPrice: 2_100, minRating: 84 },
      { resourceId: 100, maxPrice: 2_000, minRating: 84 },
    ]);
  });

  it('keeps the counters across Stop and Start, beside the log, until the reset button clears them', async () => {
    const h = setup({ results: [[auction('t-a', 8_000)], [auction('t-b', 9_000)]], maxSearches: 1 });
    h.sniper.start();
    await h.done();
    expect(h.sniper.getStats()).toMatchObject({ searches: 1, purchases: 1, coinsSpent: 8_000 });

    h.sniper.start();
    while (h.sniper.isRunning()) await new Promise((r) => setTimeout(r, 0));
    expect(h.buys).toEqual(['t-a', 't-b']);
    const stats = h.sniper.getStats();
    expect(stats).toMatchObject({ searches: 2, purchases: 2, coinsSpent: 17_000, profit: 21_000 });
    expect(stats.topSnipes).toHaveLength(2);
    expect(h.sniper.getLog().filter((e) => e.kind === 'bought')).toHaveLength(2);

    h.sniper.reset();
    expect(h.sniper.getStats()).toMatchObject({ searches: 0, purchases: 0, coinsSpent: 0, profit: 0, topSnipes: [] });
  });

  it('applies "stop after N purchases" to each run, not to the counters', async () => {
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, stopAfterPurchases: 1 } },
      results: [[auction('t-a', 8_000)], [auction('t-b', 9_000)]],
      maxSearches: 5,
    });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('purchase_limit');

    h.sniper.start();
    while (h.sniper.isRunning()) await new Promise((r) => setTimeout(r, 0));
    expect(h.buys).toEqual(['t-a', 't-b']);
    expect(h.sniper.state.stopReason).toBe('purchase_limit');
    expect(h.sniper.getStats().purchases).toBe(2);
  });

  it('counts each filter\'s searches on its own', async () => {
    const h = setup({
      filters: [
        { id: 'a', name: 'A', filter: { resourceId: 100, maxPrice: 2_200 } },
        { id: 'b', name: 'B', filter: { resourceId: 100, minPrice: 1_000, maxPrice: 2_000 } },
      ],
      results: [[], [], [], []],
      maxSearches: 4,
    });
    h.sniper.start();
    await h.done();
    const sent = h.searches as { minPrice?: number; maxPrice?: number }[];
    expect(sent.map((f) => f.maxPrice)).toEqual([2_200, 2_000, 2_100, 1_900]);
    expect(sent.map((f) => f.minPrice)).toEqual([undefined, 1_000, undefined, 1_000]);
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

  it('says why it skipped a listing, once however many searches find it', async () => {
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 15_000 } },
      results: [[auction('t-a', 8_000)]],
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual([]);
    const skips = h.sniper.getLog().filter((e) => e.message.startsWith('skipped'));
    expect(skips).toHaveLength(1);
    // 20,000 * 0.95 - 8,000 = 11,000, under the 15,000 minimum.
    expect(skips[0]!.message).toBe(
      'skipped at 8,000 coins: estimated profit 11,000 coins is under your minimum profit (15,000 coins)',
    );
  });

  it('with no minimum profit, buys before the price estimate comes back', async () => {
    let release!: (v: number | null) => void;
    const lookup = new Promise<number | null>((r) => (release = r));
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 0 } },
      results: [[auction('t-a', 8_000)]],
      estimateSellPrice: () => lookup,
      maxSearches: 1,
    });
    h.sniper.start();
    await vi.waitFor(() => expect(h.buys).toEqual(['t-a']));
    release(20_000);
    await h.done();
    // Filled in when the lookup answers, without holding the bot up.
    await vi.waitFor(() => expect(h.sniper.getLog().find((e) => e.kind === 'bought')?.sellPrice).toBe(20_000));
  });

  it('never lets a slow price lookup hold up a buy, even with a minimum profit', async () => {
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 15_000 } },
      results: [[auction('t-a', 8_000)]],
      // FUTBIN never answers: the profit is unknown, which is allowed.
      estimateSellPrice: () => new Promise<number | null>(() => undefined),
      maxSearches: 1,
    });
    h.sniper.start();
    await vi.waitFor(() => expect(h.buys).toEqual(['t-a']));
    await h.done();
  });

  it('looks a card\'s price up once for the searches that keep finding it', async () => {
    const lookups: number[] = [];
    const h = setup({
      results: [[auction('t-a', 8_000)], [auction('t-b', 8_500)], [auction('t-c', 9_000)]],
      estimateSellPrice: async (id) => {
        lookups.push(id);
        return 20_000;
      },
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a', 't-b', 't-c']);
    expect(lookups).toEqual([100]);
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

  it('keeps buys inside max buys per hour, and stops searching until the hour has room', async () => {
    const h = setup({
      settings: { ...quick, safety: safety({ maxBuysPerHour: 2 }) },
      results: [[auction('t-a', 7_000)], [auction('t-b', 8_000)], [auction('t-c', 9_000)]],
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a', 't-b', 't-c']);
    // The third search waited for the first buy (made on the first search)
    // to leave the hour: no search went out while it could buy nothing. It
    // slept a minute at a time, checking again in between.
    expect(h.searchTimes[2]! - h.searchTimes[0]!).toBeGreaterThanOrEqual(3_600_000);
    const paused = h.waits.filter((w) => w.phase === 'blocked');
    expect(paused.length).toBeGreaterThan(50);
    expect(Math.max(...paused.map((w) => w.ms))).toBe(60_000);
    expect(h.sniper.getLog().filter((e) => e.message.startsWith('Buying paused: buy limit (2 of 2 buys in the last hour)'))).toHaveLength(1);
    expect(h.sniper.getLog().some((e) => e.message.startsWith('Buying resumed'))).toBe(true);
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
    expect(risky.sniper.state.stopDetail).toBe(
      'these settings are above low risk: confirm the risk on the Nova AI page first, or reset to recommended',
    );

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

  it('buys a listing the adapter upgrades to buyable during the search', async () => {
    // The search's network response reached the adapter first (no item
    // entity yet, so unbuyable); its own search call then returned the same
    // listings and only sent the upgrade (main/adapter.ts isSecondSighting).
    const h = setup({
      results: [[auction('t-late', 8_000, { buyable: false }), auction('t-never', 9_000, { buyable: false })]],
      upgrades: [['t-late']],
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-late']);
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
    expect(
      second.sniper.getLog().some((e) => e.message.startsWith('Buying paused: coin-flow limit (9,000 of 10,000 coins in the last hour)')),
    ).toBe(true);
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

describe('Sniper — the buy:search ratio rolls with the hour', () => {
  const ratio = (patch: Partial<BotSettings['safety']> = {}): Partial<BotSettings> => ({
    searchDelay: { min: 1, max: 1 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
    safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 0.35, cooldownSeconds: 0, ...patch },
  });

  it('does not bank a long history: searches older than an hour let no burst of buys through', async () => {
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
    const h = setup({
      settings: ratio(),
      results: [[auction('t-1', 1_000), auction('t-2', 1_100), auction('t-3', 1_200)]],
      maxSearches: 1,
      budgetStore,
      startAt: start,
    });
    h.sniper.start();
    await h.done();
    // One search in the hour: one buy (the cold start's), not three.
    expect(h.buys).toEqual(['t-1']);
  });

  it('lets the first buy through on a cold start, then keeps to the ratio as searches come', async () => {
    const attempts: AttemptInput[] = [];
    const risk: unknown[] = [];
    const h = setup({
      settings: ratio(),
      // A match on every search, two on the first.
      results: [[auction('t-1', 1_000), auction('t-2', 1_100)], [auction('t-3', 1_000)], [auction('t-4', 1_000)], [auction('t-5', 1_000)]],
      maxSearches: 4,
      onAttempt: (a) => void attempts.push(a),
      onRiskEvent: (e) => void risk.push(e),
    });
    h.sniper.start();
    await h.done();
    // 0.35 a search: the first buy (counted against three searches), then
    // the next once (1 + 1) / searches <= 0.35, which takes six searches.
    expect(h.buys).toEqual(['t-1']);
    // Reported once when it started (it held on every later search), with one
    // blocked attempt per search at most.
    expect(risk).toEqual([{ kind: 'buy_search_ratio', value: 2 / 3, threshold: 0.35 }]);
    expect(attempts.filter((a) => a.outcome === 'blocked').map((a) => a.errorCode)).toEqual([
      'buy_search_ratio',
      'buy_search_ratio',
      'buy_search_ratio',
      'buy_search_ratio',
    ]);
    expect(h.sniper.state.notice).toBeNull(); // stopped: no notice
    const paused = h.sniper.getLog().filter((e) => e.message.startsWith('Buying paused: buys-per-search limit'));
    expect(paused).toHaveLength(1);
    expect(paused[0]!.message).toBe(
      'Buying paused: buys-per-search limit (1 buy for 1 search in the last hour, your limit is 0.35 a search) — resumes after about 5 more searches',
    );
    // The bot kept searching: more searches are what lower the ratio.
    expect(h.searches).toHaveLength(4);
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
    expect(h.sniper.state.stopDetail).toBe('your plan no longer includes Nova AI');
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

describe('Sniper — the saved budget could not be read (finding A)', () => {
  const saved = (start: number): BotBudgetState => ({
    governor: {
      sessionStartedAt: start - 60_000,
      actionTimestamps: [start - 60_000, start - 50_000],
      searchCount: 1,
      buyCount: 1,
      coinFlow: [{ at: start - 50_000, coins: 9_000 }],
      cooldownUntil: 0,
      killSwitchActive: false,
    },
    searchTimes: [start - 60_000],
    buyTimes: [start - 50_000],
  });

  it.each([
    ['throws (the service worker is gone)', () => Promise.reject(new Error('no answer'))],
    ['never answers usefully and rejects later', () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 0))],
  ])('when loadBudget %s at start(), it does not run, and the stored windows survive', async (_label, load) => {
    const start = 10_000_000;
    const budgetStore = { value: saved(start) as BotBudgetState | null };
    const before = structuredClone(budgetStore.value);
    const h = setup({
      maxSearches: 1,
      budgetStore,
      loadBudget: load as () => Promise<BotBudgetState | null>,
      results: [[auction('t-a', 9_000)]],
      startAt: start,
    });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('budget_unavailable');
    expect(h.searches).toHaveLength(0);
    expect(h.buys).toHaveLength(0);
    // Nothing was saved over the stored windows: no budget refilled.
    expect(budgetStore.value).toEqual(before);
  });

  it('a later start whose load works picks the stored windows up', async () => {
    const start = 10_000_000;
    const budgetStore = { value: saved(start) as BotBudgetState | null };
    let failing = true;
    const h = setup({
      settings: { safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1, cooldownSeconds: 0, maxBuysPerHour: 1 } },
      maxSearches: 1,
      budgetStore,
      loadBudget: async () => {
        if (failing) throw new Error('no answer');
        return structuredClone(budgetStore.value);
      },
      results: [[auction('t-a', 9_000)]],
      startAt: start,
    });
    h.sniper.start();
    await h.done();
    failing = false;
    const done = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!h.sniper.isRunning()) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });
    h.sniper.start();
    await done;
    // The one buy the hour allows was already spent before this page: the
    // bot searched only once that buy had left the hour.
    expect(h.searchTimes[0]! - (start - 50_000)).toBeGreaterThanOrEqual(3_600_000);
    expect(h.sniper.getLog().some((e) => e.message.startsWith('Buying paused: buy limit (1 of 1 buy in the last hour)'))).toBe(true);
    expect(h.buys).toEqual(['t-a']);
  });
});

describe('Sniper — two EA tabs, one set of hourly budgets (multi-tab)', () => {
  const settings: Partial<BotSettings> = {
    searchDelay: { min: 1, max: 1 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
    safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1, cooldownSeconds: 0, maxBuysPerHour: 2 },
  };

  it('a tab started before the other ran re-reads the budgets on its next start', async () => {
    const budgetStore = { value: null as BotBudgetState | null };
    // Tab B loads, starts and stops before tab A buys anything.
    // (Its second search, after tab A ran, finds two listings.)
    const b = setup({
      settings,
      results: [[], [auction('t-b1', 1_000), auction('t-b2', 1_000)]],
      maxSearches: 1,
      budgetStore,
    });
    b.sniper.start();
    await b.done();
    // Tab A buys the hour's two.
    const a = setup({
      settings,
      results: [[auction('t-a1', 1_000), auction('t-a2', 1_000)]],
      maxSearches: 1,
      budgetStore,
      startAt: b.clock.t,
    });
    a.sniper.start();
    await a.done();
    expect(a.buys).toEqual(['t-a1', 't-a2']);
    const aBoughtAt = budgetStore.value!.buyTimes[0]!;

    // Tab B starts again, in the same hour: it must not buy two more.
    b.clock.t = a.clock.t;
    const stopped = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!b.sniper.isRunning()) {
          clearInterval(check);
          resolve();
        }
      }, 1);
    });
    b.sniper.start();
    await stopped;
    // It searched (and bought) only once tab A's buys had left the hour.
    expect(b.searchTimes.at(-1)! - aBoughtAt).toBeGreaterThanOrEqual(3_600_000);
    expect(b.sniper.getLog().some((e) => e.message.includes('2 of 2 buys in the last hour'))).toBe(true);
  });

  it('will not start, or keep running, in a tab without the engine lease', async () => {
    const lease = { held: false };
    const h = setup({ exclusive: () => lease.held, results: [[]] });
    h.sniper.start();
    expect(h.sniper.isRunning()).toBe(false);
    expect(h.sniper.state.stopReason).toBe('other_tab');

    lease.held = true;
    let searches = () => 0;
    const running = setup({
      exclusive: () => searches() < 1,
      settings,
      results: [[]],
    });
    searches = () => running.searches.length;
    running.sniper.start();
    await running.done();
    expect(running.sniper.state.stopReason).toBe('other_tab');
    expect(running.searches).toHaveLength(1);
  });

  it('a tab that lost the lease never saves its stale budget over the new holder’s (Q-I1)', async () => {
    const budgetStore = { value: null as BotBudgetState | null };
    const lease = { holder: 'A' as 'A' | 'B' };
    // Tab A runs and buys once, then is frozen (its sleep never returns)
    // while it still thinks it is running.
    let freeze!: () => void;
    const frozen = new Promise<void>((r) => (freeze = r));
    const a = setup({
      settings,
      results: [[auction('t-a1', 1_000)]],
      budgetStore,
      exclusive: () => lease.holder === 'A',
    });
    (a.sniper as unknown as { sleep: () => Promise<void> }).sleep = () => frozen;
    a.sniper.start();
    await vi.waitFor(() => expect(a.buys).toEqual(['t-a1']));
    expect(a.sniper.isRunning()).toBe(true);

    // The lease passes to tab B, which loads A's windows, buys and saves.
    lease.holder = 'B';
    const b = setup({
      settings,
      results: [[auction('t-b1', 1_000)]],
      maxSearches: 1,
      budgetStore,
      exclusive: () => lease.holder === 'B',
      startAt: a.clock.t,
    });
    b.sniper.start();
    await b.done();
    expect(b.buys).toEqual(['t-b1']);
    const bSaved = structuredClone(budgetStore.value);
    expect(bSaved!.buyTimes).toHaveLength(2);

    // Tab A wakes and is stopped (onLose, or its own exclusive check).
    a.sniper.stop('other_tab');
    freeze();
    await new Promise((r) => setTimeout(r, 0));
    expect(budgetStore.value).toEqual(bSaved);
  });
});

describe('Sniper — auto-sell after a buy', () => {
  const autoSell = (over: Partial<BotSettings['autoSell']>): Partial<BotSettings> => ({
    autoSell: { ...DEFAULT_BOT_SETTINGS.autoSell, enabled: true, ...over },
  });
  const listedLog = (h: Harness) => h.sniper.getLog().find((e) => e.kind === 'listed');
  // The listing runs on its own after a buy: let it finish.
  const settled = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const notListed = (h: Harness) => h.sniper.getLog().find((e) => e.message.startsWith('not listed'));

  it('lists at the FUTBIN price moved by the chosen steps, starting bid one step lower', async () => {
    const h = setup({
      settings: autoSell({ steps: -2 }),
      results: [[auction('t-a', 8_000)]],
      marketPrice: async () => ({ price: 20_000, source: 'futbin' }),
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    expect(h.buys).toEqual(['t-a']);
    // 20,000 -> 19,750 -> 19,500 (250-coin steps), bid one step under.
    expect(h.lists).toEqual([['t-a', 19_250, 19_500]]);
    expect(listedLog(h)).toMatchObject({ price: 19_500, message: 'FUTBIN price 20,000 coins, -2 steps' });
  });

  it('says when the price came from Nova\'s own market data', async () => {
    const h = setup({
      settings: autoSell({ steps: 1 }),
      results: [[auction('t-a', 8_000)]],
      marketPrice: async () => ({ price: 12_000, source: 'nova' }),
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    expect(h.lists).toEqual([['t-a', 12_000, 12_250]]);
    expect(listedLog(h)?.message).toBe('Nova market price 12,000 coins, +1 step');
  });

  it('lists at the fixed price, put on EA\'s grid', async () => {
    const h = setup({
      settings: autoSell({ mode: 'fixed', fixedPrice: 15_100 }),
      results: [[auction('t-a', 8_000)]],
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    expect(h.lists).toEqual([['t-a', 14_750, 15_000]]);
    expect(listedLog(h)?.message).toBe('your fixed price');
  });

  it("shows the buy at the user's own sell price, not a market estimate they never chose", async () => {
    const h = setup({
      settings: {
        ...autoSell({ mode: 'fixed', fixedPrice: 1_700 }),
        thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 0 },
      },
      results: [[auction('t-a', 2_200)]],
      // Nova's estimate said 2,500: the user said 1,700.
      sellPrice: 2_500,
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    const bought = h.sniper.getLog().find((e) => e.kind === 'bought');
    // 1,700 less 5% is 1,615: 585 under the 2,200 paid.
    expect(bought).toMatchObject({ price: 2_200, sellPrice: 1_700, profit: -585 });
    expect(h.sniper.getStats().profit).toBe(-585);
    expect(notListed(h)?.message).toBe(
      "not listed: 1,700 coins would lose money after EA's 5% tax (bought for 2,200 coins)",
    );
  });

  it("skips a buy the user's own sell price makes a loss, under a minimum profit", async () => {
    const h = setup({
      settings: {
        ...autoSell({ mode: 'fixed', fixedPrice: 1_700 }),
        thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 100 },
      },
      results: [[auction('t-a', 2_200)]],
      sellPrice: 2_500,
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    expect(h.buys).toEqual([]);
  });

  it('shows the buy at the market price moved by the steps auto-sell lists at', async () => {
    const h = setup({
      settings: autoSell({ steps: -2 }),
      results: [[auction('t-a', 8_000)]],
      sellPrice: 20_000,
      marketPrice: async () => ({ price: 20_000, source: 'futbin' }),
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    expect(h.sniper.getLog().find((e) => e.kind === 'bought')).toMatchObject({ sellPrice: 19_500 });
    expect(listedLog(h)?.price).toBe(19_500);
  });

  it('keeps the card when there is no market price for it', async () => {
    const h = setup({
      settings: autoSell({}),
      results: [[auction('t-a', 8_000)]],
      marketPrice: async () => null,
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    expect(h.lists).toEqual([]);
    expect(notListed(h)?.message).toBe('not listed: no market price for this card (FUTBIN and Nova have none)');
  });

  it('never lists at a loss after EA\'s tax, unless told to', async () => {
    const run = async (noLoss: boolean) => {
      const h = setup({
        settings: autoSell({ noLoss }),
        results: [[auction('t-a', 8_000)]],
        // 8,000 after 5% tax is 7,600: under the 8,000 paid.
        marketPrice: async () => ({ price: 8_000, source: 'futbin' }),
        maxSearches: 1,
      });
      h.sniper.start();
      await h.done();
    await settled();
      return h;
    };
    const guarded = await run(true);
    expect(guarded.lists).toEqual([]);
    expect(notListed(guarded)?.message).toBe(
      "not listed: 8,000 coins would lose money after EA's 5% tax (bought for 8,000 coins)",
    );
    expect((await run(false)).lists).toEqual([['t-a', 7_900, 8_000]]);
  });

  it('keeps searching while a listing is still on its way', async () => {
    const h = setup({
      settings: autoSell({ mode: 'fixed', fixedPrice: 15_000 }),
      results: [[auction('t-a', 8_000)], []],
      // EA never answers the listing.
      listResult: () => new Promise(() => undefined) as unknown as ActionOutcome,
      maxSearches: 2,
    });
    h.sniper.start();
    await h.done();
    expect(h.lists).toHaveLength(1);
    expect(h.searches).toHaveLength(2);
  });

  it('does nothing when auto-sell is off', async () => {
    const h = setup({
      results: [[auction('t-a', 8_000)]],
      marketPrice: async () => ({ price: 20_000, source: 'futbin' }),
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    expect(h.buys).toEqual(['t-a']);
    expect(h.lists).toEqual([]);
  });

  it('logs EA refusing the listing', async () => {
    const h = setup({
      settings: autoSell({ mode: 'fixed', fixedPrice: 15_000 }),
      results: [[auction('t-a', 8_000)]],
      listResult: () => ({ ok: false, error: 'list reported success: false', latencyMs: 5 }),
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    await settled();
    expect(notListed(h)?.message).toBe('not listed: list reported success: false');
  });
});

describe('Sniper — a missed buy says why, in plain words', () => {
  it("logs the reason, not EA's wording or the timings", async () => {
    const h = setup({
      results: [[auction('t-a', 8_000)]],
      buyResult: () => ({ ok: false, error: 'bid reported success: false (status 403)', latencyMs: 182 }),
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    const missed = h.sniper.getLog().find((e) => e.kind === 'failed');
    expect(missed?.message).toBe('someone else got it first');
  });

  it("puts EA's codes and the adapter's refusals into words", () => {
    expect(missReason('bid reported success: false (status 461)')).toBe('someone else got it first');
    expect(missReason('bid reported success: false (status 478)')).toBe('someone else got it first');
    expect(missReason('bid reported success: false (status 470)')).toBe('not enough coins');
    expect(missReason('bid reported success: false (status 458)')).toBe('EA wants a verification: solve it in the web app');
    expect(missReason('bid reported success: false (status 512)')).toBe('EA is limiting requests: slow the bot down');
    expect(missReason('bid reported success: false (status 500)')).toBe('EA refused it (error 500)');
    expect(missReason(ACT_ERROR.priceMismatch)).toBe('the price changed');
    expect(missReason(ACT_ERROR.listingUnknown)).toBe('the listing was gone');
    expect(missReason('timed out waiting for adapter response')).toBe('EA did not answer in time');
    expect(missReason(undefined)).toBe('EA did not say why');
  });
});

describe('Sniper — searches start one delay apart, start to start', () => {
  const fixedDelay = { searchDelay: { min: 8, max: 8 }, breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false } };

  it("takes EA's answer time out of the delay instead of adding it", async () => {
    const h = setup({ settings: fixedDelay, results: [[]], searchTakesMs: 2_000, maxSearches: 3 });
    h.sniper.start();
    await h.done();
    expect(h.waits.filter((w) => w.phase === 'waiting').map((w) => w.ms)).toEqual([6_000, 6_000, 6_000]);
    // So searches go out exactly 8 s apart.
    expect(h.searchTimes[1]! - h.searchTimes[0]!).toBe(8_000);
    expect(h.searchTimes[2]! - h.searchTimes[1]!).toBe(8_000);
  });

  it('after a buy and its pause, searches again without waiting a second time', async () => {
    const h = setup({
      settings: { ...fixedDelay, safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1, cooldownSeconds: 10 } },
      results: [[auction('t-a', 8_000)], []],
      maxSearches: 2,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a']);
    // 10 s pause after the buy already covers the 8 s delay.
    expect(h.searchTimes[1]! - h.searchTimes[0]!).toBe(10_000);
  });
});

describe('Sniper — says at Start whether it keeps searching in a background tab', () => {
  it.each([
    ['worker' as const, 'Background searching is on: the bot keeps its pace in another tab'],
    [
      'page' as const,
      "Background searching is limited: this page blocked the bot's background timer, so searching slows down while the tab is hidden",
    ],
  ])('%s', async (mode, message) => {
    const h = setup({ results: [[]], timingMode: () => mode, maxSearches: 1 });
    h.sniper.start();
    await h.done();
    expect(h.sniper.getLog().some((e) => e.message === message)).toBe(true);
  });
});

describe('searchMaxBuy', () => {
  it('steps the max buy-now price down from the cap, five steps at most, then starts over', () => {
    expect(Array.from({ length: 7 }, (_, i) => searchMaxBuy(i, undefined, 16_000))).toEqual([
      16_000, 15_750, 15_500, 15_250, 15_000, 14_750, 16_000,
    ]);
  });

  it("keeps within 10% of the cap after the first step, on EA's grid, and never above the cap", () => {
    expect(Array.from({ length: 4 }, (_, i) => searchMaxBuy(i, undefined, 1_000))).toEqual([1_000, 950, 900, 1_000]);
    expect(Array.from({ length: 3 }, (_, i) => searchMaxBuy(i, undefined, 300))).toEqual([300, 250, 300]);
    // An off-grid cap is searched as set, then stepped along the grid under it.
    expect(Array.from({ length: 3 }, (_, i) => searchMaxBuy(i, undefined, 16_100))).toEqual([16_100, 15_750, 15_500]);
  });

  it("never steps to the filter's own min or under EA's lowest buy-now price", () => {
    expect([0, 1, 2].map((i) => searchMaxBuy(i, 2_100, 2_200))).toEqual([2_200, 2_200, 2_200]);
    expect([0, 1].map((i) => searchMaxBuy(i, undefined, 200))).toEqual([200, 200]);
  });

  it("with no cap, steps down from EA's highest buy-now price, leaving nothing out", () => {
    expect(Array.from({ length: 7 }, (_, i) => searchMaxBuy(i, undefined, null))).toEqual([
      undefined,
      15_000_000,
      14_999_000,
      14_998_000,
      14_997_000,
      14_996_000,
      undefined,
    ]);
  });
});

describe('Sniper — the hourly budgets count buys that bought', () => {
  const quick = (patch: Partial<BotSettings['safety']>): Partial<BotSettings> => ({
    searchDelay: { min: 1, max: 1 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
    safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1, cooldownSeconds: 0, ...patch },
  });
  const lostRace: ActionOutcome = {
    ok: false,
    error: 'bid reported success: false (status 403)',
    signed: true,
    latencyMs: 150,
  };

  it('a buy EA turned down uses none of the buys per hour, the coin flow or the ratio, and still counts as an action', async () => {
    const budgetStore = { value: null as BotBudgetState | null };
    const h = setup({
      settings: quick({ maxBuysPerHour: 1, maxCoinFlowPerHour: 10_000 }),
      results: [[auction('t-lost', 9_000), auction('t-won', 9_500)]],
      buyResult: (id) => (id === 't-lost' ? lostRace : { ok: true, signed: true, latencyMs: 600 }),
      maxSearches: 1,
      budgetStore,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-lost', 't-won']);
    expect(budgetStore.value!.buyTimes).toHaveLength(1);
    expect(budgetStore.value!.governor.coinFlow.map((c) => c.coins)).toEqual([9_500]);
    // The search and both buy requests: what EA saw, the ban-risk backstop.
    expect(h.sniper.getGovernor()!.snapshot().actionsLastHour).toBe(3);
  });

  it("a buy that timed out stays charged until EA's signed late answer says it did not buy", async () => {
    let settleLate!: (o: ActionOutcome) => void;
    const late = new Promise<ActionOutcome>((r) => (settleLate = r));
    const budgetStore = { value: null as BotBudgetState | null };
    const h = setup({
      settings: quick({}),
      results: [[auction('t-slow', 8_000)]],
      buyResult: () => ({ ok: false, error: ACT_ERROR.timeoutUnknown, signed: true, latencyMs: 15_000, late }),
      maxSearches: 1,
      budgetStore,
    });
    h.sniper.start();
    await h.done();
    expect(budgetStore.value!.buyTimes).toHaveLength(1);
    expect(budgetStore.value!.governor.coinFlow.map((c) => c.coins)).toEqual([8_000]);
    settleLate({ ok: false, signed: true, latencyMs: 20_000 });
    await vi.waitFor(() => expect(budgetStore.value!.buyTimes).toEqual([]));
    expect(budgetStore.value!.governor.coinFlow).toEqual([]);
  });

  it('a spent coin flow: one log line, one risk event, one blocked attempt per search, and no search until it frees', async () => {
    const attempts: AttemptInput[] = [];
    const risk: unknown[] = [];
    const h = setup({
      settings: quick({ maxCoinFlowPerHour: 20_000 }),
      results: [
        [auction('t-a', 9_000)],
        [auction('t-b', 9_000)],
        [auction('t-c', 9_000), auction('t-d', 9_000), auction('t-e', 9_000)],
      ],
      maxSearches: 4,
      onAttempt: (a) => void attempts.push(a),
      onRiskEvent: (e) => void risk.push(e),
    });
    h.sniper.start();
    await h.done();
    const firstBuyAt = h.searchTimes[0]!;
    // 18,000 spent: the third search's 9,000 would make 27,000 of 20,000.
    // Its other listings cost as much: not tried, not reported.
    const blocked = attempts.filter((a) => a.outcome === 'blocked');
    expect(blocked.map((a) => [a.tradeId, a.errorCode])).toEqual([
      ['t-c', 'coin_flow'],
      // After the pause: one more buy fit, then the next did not.
      ['t-d', 'coin_flow'],
    ]);
    expect(risk).toEqual([
      { kind: 'coin_flow', value: 27_000, threshold: 20_000 },
      { kind: 'coin_flow', value: 27_000, threshold: 20_000 },
    ]);
    // No search went out until the first buy had left the hour.
    expect(h.searches).toHaveLength(4);
    expect(h.searchTimes[3]! - firstBuyAt).toBeGreaterThanOrEqual(3_600_000);
    expect(h.buys).toEqual(['t-a', 't-b', 't-c']);
    const resumes = new Date(firstBuyAt + 3_600_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const message = `Buying paused: coin-flow limit (18,000 of 20,000 coins in the last hour) — resumes about ${resumes}`;
    // One line each time it started (the log is newest first).
    const lines = h.sniper.getLog().filter((e) => e.message.startsWith('Buying paused: coin-flow limit'));
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)!.message).toBe(message);
    // The page showed it the whole time it waited.
    const paused = h.waits.filter((w) => w.phase === 'blocked');
    expect(paused.length).toBeGreaterThan(0);
    for (const w of paused) expect(w.notice).toBe(message);
    expect(h.sniper.getLog().filter((e) => e.message.startsWith('Buying resumed'))).toHaveLength(1);
    expect(h.sniper.state.notice).toBeNull();
  });

  it('buys per hour running out mid-search: one blocked attempt, one risk event, and the rest of that search left', async () => {
    const attempts: AttemptInput[] = [];
    const risk: unknown[] = [];
    const h = setup({
      settings: quick({ maxBuysPerHour: 1 }),
      results: [[], [auction('t-a', 1_000), auction('t-b', 1_100), auction('t-c', 1_200)]],
      maxSearches: 2,
      onAttempt: (a) => void attempts.push(a),
      onRiskEvent: (e) => void risk.push(e),
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a']);
    expect(attempts.filter((a) => a.outcome === 'blocked').map((a) => [a.tradeId, a.errorCode])).toEqual([
      ['t-b', 'buys_per_hour'],
    ]);
    expect(risk).toEqual([{ kind: 'actions_per_hour', value: 2, threshold: 1 }]);
    const waiting = h.waits.find((w) => w.phase === 'waiting' && w.notice);
    expect(waiting?.notice).toMatch(/^Buying paused: buy limit \(1 of 1 buy in the last hour\) — resumes about \d{1,2}:\d{2}/);
  });

  it('a pause for an hourly budget does not count toward the active hours a day', async () => {
    const h = setup({
      settings: quick({ maxBuysPerHour: 1, maxActiveHoursPerDay: 1 }),
      results: [[auction('t-a', 1_000)], []],
      maxSearches: 2,
    });
    h.sniper.start();
    await h.done();
    // An hour paused for the buy limit, then the second search: not stopped
    // for the day, which an hour of active time would have done.
    expect(h.searches).toHaveLength(2);
    expect(h.searchTimes[1]! - h.searchTimes[0]!).toBeGreaterThanOrEqual(3_600_000);
    expect(h.sniper.state.stopReason).toBe('manual');
    expect(h.sniper.getActiveMsToday()).toBeLessThan(60_000);
  });

  it("the governor's actions per hour (lost races count there): sleeps until the window has room, reported once", async () => {
    const risk: unknown[] = [];
    const h = setup({
      // 3 searches + 1 buy an hour: the governor's backstop is 4 actions.
      settings: quick({ maxSearchesPerHour: 3, maxBuysPerHour: 1 }),
      results: [[auction('t-1', 1_000), auction('t-2', 1_100)], [auction('t-3', 1_000)]],
      buyResult: () => lostRace,
      maxSearches: 3,
      onRiskEvent: (e) => void risk.push(e),
    });
    h.sniper.start();
    await h.done();
    // Search, two lost races, search: the third buy request would be the fifth action.
    expect(h.buys.slice(0, 2)).toEqual(['t-1', 't-2']);
    expect(risk).toEqual([{ kind: 'actions_per_hour', value: 5, threshold: 4 }]);
    expect(h.searchTimes[2]! - h.searchTimes[0]!).toBeGreaterThanOrEqual(3_600_000);
    const paused = h.sniper.getLog().filter((e) => e.message.startsWith('Paused: safety limit of 4 searches and buys an hour (4 in the last hour)'));
    expect(paused).toHaveLength(1);
  });
});

describe('Sniper — a pause after a buy leaves the rest of that search', () => {
  it('buys the cheapest, waits its pause, then searches again instead of buying what is now stale', async () => {
    const h = setup({
      settings: { safety: { ...DEFAULT_BOT_SETTINGS.safety, buyToSearchRatio: 1, cooldownSeconds: 10 } },
      results: [[], [auction('t-a', 8_000), auction('t-b', 9_000)], []],
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a']);
    expect(h.searches).toHaveLength(3);
  });
});

describe('Sniper — the minimum profit, checked without waiting', () => {
  it("uses the user's fixed sell price less EA's 5% tax, with no lookup at all", async () => {
    const estimateSellPrice = vi.fn(async () => 30_000);
    const h = setup({
      settings: { autoSell: { ...DEFAULT_BOT_SETTINGS.autoSell, mode: 'fixed', fixedPrice: 17_000 } },
      filters: [{ id: 'f1', name: 'Target', filter: { resourceId: 100, maxPrice: 20_000 } }],
      results: [[auction('t-thin', 16_000), auction('t-ok', 15_000)]],
      estimateSellPrice,
      maxSearches: 1,
    });
    h.sniper.start();
    await h.done();
    // 17,000 less 5% is 16,150: 150 over a 16,000 buy, under the default 1,000.
    expect(h.buys).toEqual(['t-ok']);
    expect(
      h.sniper
        .getLog()
        .some((e) => e.message === 'skipped at 16,000 coins: estimated profit 150 coins is under your minimum profit (1,000 coins)'),
    ).toBe(true);
    expect(h.sniper.getLog().find((e) => e.kind === 'bought')).toMatchObject({ sellPrice: 17_000, profit: 1_150 });
    expect(estimateSellPrice).not.toHaveBeenCalled();
  });

  it("looks the target card's market price up at Start, before the first search", () => {
    const estimateSellPrice = vi.fn(async () => 20_000);
    const h = setup({ estimateSellPrice });
    h.sniper.start();
    expect(estimateSellPrice).toHaveBeenCalledWith(100);
    expect(h.searches).toHaveLength(0);
    h.sniper.stop();
  });

  it('a lookup still out lets the buy go (unknown profit), and the next search checks against its answer', async () => {
    let answer!: (price: number | null) => void;
    const lookup = new Promise<number | null>((r) => (answer = r));
    const estimateSellPrice = vi.fn(() => lookup);
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 15_000 } },
      // No player in the search: nothing to look up at Start.
      filters: [{ id: 'f1', name: 'Gold', filter: { minRating: 80, maxPrice: 10_000 } }],
      results: [[auction('t-a', 8_000)], [auction('t-b', 8_000)]],
      estimateSellPrice,
      // The price is known only once the first buy has gone out.
      buyResult: (id) => {
        if (id === 't-a') answer(20_000);
        return { ok: true, signed: true, latencyMs: 5 };
      },
      maxSearches: 2,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual(['t-a']);
    expect(
      h.sniper
        .getLog()
        .some((e) => e.message === 'skipped at 8,000 coins: estimated profit 11,000 coins is under your minimum profit (15,000 coins)'),
    ).toBe(true);
    expect(estimateSellPrice.mock.calls).toEqual([[100]]);
  });

  it('plannedSalePrice: the fixed price on the grid, else the market price, stepped when auto-sell lists', () => {
    const a = DEFAULT_BOT_SETTINGS.autoSell;
    expect(plannedSalePrice({ ...a, mode: 'fixed', fixedPrice: 15_100 }, 20_000)).toBe(15_000);
    expect(plannedSalePrice({ ...a, mode: 'market', enabled: true, steps: -2 }, 20_000)).toBe(19_500);
    expect(plannedSalePrice({ ...a, mode: 'market', enabled: false, steps: -2 }, 20_000)).toBe(20_000);
    expect(plannedSalePrice({ ...a, mode: 'market' }, null)).toBeNull();
  });
});

describe('Sniper — pace report', () => {
  it('reports how often it searched, what came back and where the time went, then starts a new window', async () => {
    const h = setup({
      // Two empty searches and one with a listing over the cap (not bought).
      results: [[], [auction('t-x', 50_000)], []],
      searchTakesMs: 150,
      settings: { searchDelay: { min: 2, max: 2 }, breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false } },
      maxSearches: 3,
    });
    h.sniper.start();
    await h.done();
    // The stop lands inside the last wait, which settles a tick later.
    await new Promise((r) => setTimeout(r, 0));
    const pace = h.sniper.takePace();
    expect(pace).toMatchObject({
      searches: 3,
      withResults: 1,
      failed: 0,
      searchMsP50: 150,
      searchMsP90: 150,
      blockedMs: 0,
      backoffMs: 0,
      breakMs: 0,
      cooldownMs: 0,
    });
    // The 2 s delay runs from one search's start to the next: 1.85 s of
    // waiting after each 150 ms search (the third is cut short by the stop).
    expect(pace!.waitingMs).toBe(2 * 1_850 + 1_850);
    expect(pace!.windowMs).toBe(h.clock.t - 1_000_000);
    // A new window, and nothing happened in it.
    expect(h.sniper.takePace()).toBeNull();
  });
});

describe('Sniper — buys as soon as the listings arrive', () => {
  it("buys before the search's own answer is back, and logs how fast it reacted", async () => {
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    const h = setup({ results: [[auction('t-a', 8_000)]], answerLagMs: 40, holdAnswer: () => held, maxSearches: 1 });
    h.sniper.start();
    await vi.waitFor(() => expect(h.buys).toEqual(['t-a']));
    // The search has not answered yet: nothing recorded for it.
    expect(h.sniper.getSearchResults()).toHaveLength(0);
    answer();
    await h.done();
    expect(h.sniper.getSearchResults()[0]!.matches.map((m) => m.tradeId)).toEqual(['t-a']);
    // The listings arrived, then the buy went out once the clock had moved 40 ms.
    expect(h.sniper.getLog().find((e) => e.kind === 'bought')?.reactionMs).toBe(40);
  });

  it('reports where the time before each buy went: EA answering the search, then the bot reacting', async () => {
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    const attempts: AttemptInput[] = [];
    const h = setup({
      results: [[auction('t-a', 8_000), auction('t-b', 8_100)]],
      searchTakesMs: 120,
      answerLagMs: 40,
      holdAnswer: () => held,
      // Someone else's buy landed first on the cheaper one (EA's signed refusal).
      buyResult: (id) =>
        id === 't-a'
          ? { ok: false, signed: true, error: 'bid reported success: false (status 403)', latencyMs: 5 }
          : { ok: true, latencyMs: 5 },
      onAttempt: (a) => void attempts.push(a),
      maxSearches: 1,
    });
    h.sniper.start();
    await vi.waitFor(() => expect(h.buys).toEqual(['t-a', 't-b']));
    answer();
    await h.done();
    // The search took 120 ms to bring the listings; the bot sent its buys
    // 40 ms after they arrived (the fake clock stands still during the buys).
    expect(attempts.map((a) => [a.tradeId, a.outcome, a.searchMs, a.reactionMs])).toEqual([
      ['t-a', 'too_slow', 120, 40],
      ['t-b', 'success', 120, 40],
    ]);
  });

  it('then buys what the answer itself makes buyable, never anything twice', async () => {
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    const h = setup({
      results: [[], [auction('t-now', 8_000), auction('t-later', 7_000, { buyable: false })]],
      upgrades: [[], ['t-later']],
      holdAnswer: (n) => (n === 2 ? held : undefined),
      maxSearches: 2,
    });
    h.sniper.start();
    await vi.waitFor(() => expect(h.buys).toEqual(['t-now']));
    answer();
    await h.done();
    expect(h.buys).toEqual(['t-now', 't-later']);
  });
});

describe('Sniper — how a missed buy is reported', () => {
  it('too_slow for a lost race or a gone listing, error when EA limits requests, failed otherwise; errorCode within the schema', async () => {
    const attempts: AttemptInput[] = [];
    const long = `bid failed: ${'x'.repeat(200)}`;
    const answers: Record<string, ActionOutcome> = {
      't-403': { ok: false, error: 'bid reported success: false (status 403)', signed: true, latencyMs: 120 },
      't-512': { ok: false, error: 'bid reported success: false (status 512)', signed: true, latencyMs: 300 },
      't-long': { ok: false, error: long, signed: true, latencyMs: 400 },
      't-gone': { ok: false, error: ACT_ERROR.listingUnknown, signed: true, latencyMs: 1 },
    };
    const h = setup({
      results: [[auction('t-403', 1_000), auction('t-512', 1_100), auction('t-long', 1_200), auction('t-gone', 1_300)]],
      buyResult: (id) => answers[id]!,
      maxSearches: 1,
      onAttempt: (a) => void attempts.push(a),
    });
    h.sniper.start();
    await h.done();
    expect(attempts.map((a) => [a.tradeId, a.outcome, a.errorCode])).toEqual([
      ['t-403', 'too_slow', 'bid reported success: false (status 403)'],
      ['t-512', 'error', 'bid reported success: false (status 512)'],
      ['t-long', 'failed', long.slice(0, 80)],
      ['t-gone', 'too_slow', ACT_ERROR.listingUnknown],
    ]);
    expect(h.sniper.getStats().failures).toBe(4);
  });

  it('missOutcome and attemptErrorCode', () => {
    expect(missOutcome('bid reported success: false (status 461)')).toBe('too_slow');
    expect(missOutcome('bid reported success: false (status 478)')).toBe('too_slow');
    expect(missOutcome('bid reported success: false (status 429)')).toBe('error');
    expect(missOutcome('bid reported success: false (status 521)')).toBe('error');
    expect(missOutcome('bid reported success: false (status 500)')).toBe('error');
    expect(missOutcome('bid reported success: false (status 470)')).toBe('failed');
    expect(missOutcome('bid reported success: false (status 426)')).toBe('failed');
    expect(missOutcome(ACT_ERROR.priceMismatch)).toBe('failed');
    expect(missOutcome(undefined)).toBe('failed');
    expect(attemptErrorCode('')).toBe('unknown_error');
    expect(attemptErrorCode(undefined)).toBe('unknown_error');
    expect(attemptErrorCode('y'.repeat(81))).toHaveLength(80);
  });

  it('attemptTiming: whole ms within what the schema takes, else left out', () => {
    expect(attemptTiming(182.4)).toBe(182);
    expect(attemptTiming(0)).toBe(0);
    expect(attemptTiming(600_000)).toBe(600_000);
    for (const bad of [undefined, -1, 600_001, Number.NaN, Number.POSITIVE_INFINITY]) expect(attemptTiming(bad)).toBeUndefined();
  });
});
