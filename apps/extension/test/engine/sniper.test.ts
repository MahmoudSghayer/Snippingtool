// The Sniping Bot loop (`engine/sniper.ts`): search -> buy under the price
// cap, pacing (delay, breaks, rests), the user's thresholds, and the stops the
// user cannot turn off (kill switch, adapter probe failure, governor limits).
// A fake adapter and a fake clock stand in for EA's app and for real time:
// `sleep` advances the clock instantly.

import { DEFAULT_BOT_SETTINGS, type BotSettings, type TrimmedAuction } from '@sl/shared';
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
}): Harness {
  // Ratio 1 so a buy on the very first search is allowed; the ratio itself
  // is the governor's concern and is covered in governor.test.ts.
  const settings: BotSettings = {
    ...DEFAULT_BOT_SETTINGS,
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
