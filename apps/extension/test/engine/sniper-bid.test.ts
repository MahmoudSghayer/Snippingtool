// Nova AI's Bid mode (`engine/sniper.ts`, `runBids`; decisions in
// `engine/bidder.ts`): bids in an auction's last minutes up to the search's
// max price, re-bids when outbid until the next step would pass the max and
// then drops the auction, buys with Buy Now when that is at or under the
// max, holds the user's max open bids, and moves (or, with auto-sell on,
// lists) what it wins. The coins its standing bids hold count against the
// session budget, the coins EA says the trader has and the governor's coin
// flow; every Snipe mode rail (EA's rate limits included) applies; and it
// refuses to run where the watch list cannot be read. Snipe mode is
// untouched (test/engine/sniper*.test.ts pin it; one check here too).
//
// A fake EA stands in for the market and the watch list: the bot's bids land
// on the watch list as EA would put them, and each test moves the auctions
// on (outbid, won, lost) between reads. `sleep` advances a fake clock.

import {
  DEFAULT_BOT_MODE_SETTINGS,
  DEFAULT_BOT_SETTINGS,
  type AdapterEaError,
  type BotBudgetState,
  type BotModeSettings,
  type BotSettings,
  type FilterCriteria,
  type TrimmedAuction,
  type WatchedAuction,
} from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { Sniper, bidMissReason, moveMissReason, type SniperDeps } from '../../src/engine/sniper.js';

import type { ActionOutcome } from '../../src/content/adapter-client.js';
import type { AttemptInput, TradeInput } from '../../src/engine/types.js';

const START = 1_000_000;
const SEC = 1_000;
const MIN = 60_000;

/** An auction `secondsLeft` from the clock's start. */
function auction(tradeId: string, secondsLeft: number, extra: Partial<TrimmedAuction> = {}): TrimmedAuction {
  return {
    tradeId,
    resourceId: 100,
    assetId: 100,
    rating: 85,
    buyNow: 20_000,
    startingBid: 10_000,
    currentBid: 0,
    offers: 0,
    expiresAt: START + secondsLeft * SEC,
    seenAt: START,
    itemId: `item-${tradeId}`,
    ...extra,
  };
}

/** One auction on EA's side: where the trader's bid stands, and when it ends. */
interface EaAuction {
  a: TrimmedAuction;
  bidState: WatchedAuction['bidState'];
  tradeState: WatchedAuction['tradeState'];
  currentBid: number;
}

interface Opts {
  settings?: Partial<BotSettings>;
  bidding?: Partial<BotModeSettings['bidding']>;
  mode?: BotModeSettings['mode'];
  filter?: FilterCriteria;
  /** What the `n`th search (1 first) finds. Default: nothing. */
  results?: (n: number) => TrimmedAuction[];
  /** EA's answer to a bid. Default: taken (the trader leads). */
  bidResult?: (tradeId: string, price: number) => ActionOutcome;
  /** Called before the `n`th watch list read (1 first), to move EA on. */
  beforeRead?: (n: number, ea: Map<string, EaAuction>, now: number) => void;
  /** Replaces the `n`th watch list answer. */
  watchlistResult?: (n: number) => ActionOutcome | undefined;
  /** EA errors the `n`th search reports, and its outcome. */
  searchEaError?: (n: number) => Omit<AdapterEaError, 'seenAt'> | undefined;
  /** An EA error a bid reports (before its signed answer). */
  bidEaError?: Omit<AdapterEaError, 'seenAt'>;
  credits?: () => number | null;
  /** No Bid mode calls at all (an adapter built without them). */
  noBidding?: boolean;
  /** EA's answer to a Clear expired. Default: the finished auctions it did
   * not win go off the watch list. */
  clearResult?: () => ActionOutcome | undefined;
  /** Stops the bot at the wait after which this is true. */
  stopWhen?: (h: Harness) => boolean;
  budgetStore?: { value: BotBudgetState | null };
  /** The server kill switch, read before every action. */
  killSwitch?: { active: boolean };
  /** Whether this tab holds the engine lease, read before every action. */
  exclusive?: () => boolean;
}

interface Harness {
  sniper: Sniper;
  clock: { t: number };
  searches: { filter: FilterCriteria; options?: { maxBid?: number } }[];
  searchTimes: number[];
  bids: [string, number, unknown][];
  buys: [string, number][];
  moves: string[];
  lists: [string, number, number][];
  reads: number;
  /** When each Clear expired went out. */
  clears: number[];
  attempts: AttemptInput[];
  trades: TradeInput[];
  ea: Map<string, EaAuction>;
  /** The page's notice and the bid status at each wait. */
  notices: (string | null)[];
  statuses: ReturnType<Sniper['getBidStatus']>[];
  /** The log's messages (`{card}` where the page puts the card's name),
   * with the second line after a `|`. */
  log: () => string[];
  /** Settles once the bot has stopped, and what it does on its own after a
   * win has run. */
  done: () => Promise<void>;
}

function setup(opts: Opts = {}): Harness {
  const settings: BotSettings = {
    ...DEFAULT_BOT_SETTINGS,
    riskAcknowledgedAt: '2026-09-24T00:00:00.000Z',
    searchDelay: { min: 10, max: 10 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
    thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 0 },
    safety: { ...DEFAULT_BOT_SETTINGS.safety, maxSearchesPerHour: 7_200, buyToSearchRatio: 1, cooldownSeconds: 0 },
    ...opts.settings,
  };
  const modeSettings: BotModeSettings = {
    mode: opts.mode ?? 'bid',
    bidding: { ...DEFAULT_BOT_MODE_SETTINGS.bidding, ...opts.bidding },
  };
  const clock = { t: START };
  const ea = new Map<string, EaAuction>();
  const listeners = {
    auctions: new Set<(a: TrimmedAuction[]) => void>(),
    eaError: new Set<(e: AdapterEaError) => void>(),
  };
  const subscribe =
    <T>(set: Set<T>) =>
    (cb: T) => {
      set.add(cb);
      return () => set.delete(cb);
    };
  let finished!: () => void;
  const finishedPromise = new Promise<void>((r) => (finished = r));

  const h: Harness = {
    sniper: null as unknown as Sniper,
    clock,
    searches: [],
    searchTimes: [],
    bids: [],
    buys: [],
    moves: [],
    lists: [],
    reads: 0,
    clears: [],
    attempts: [],
    trades: [],
    ea,
    notices: [],
    statuses: [],
    log: () => h.sniper.getLog().map((e) => (e.detail ? `${e.message} | ${e.detail}` : e.message)),
    done: async () => {
      await finishedPromise;
      // What runs on its own after a win (moving, listing) settles.
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };

  const seen = new Map<string, TrimmedAuction>();
  const adapter: SniperDeps['adapter'] = {
    search: async (filter, options) => {
      h.searches.push({ filter, options });
      h.searchTimes.push(clock.t);
      const n = h.searches.length;
      const e = opts.searchEaError?.(n);
      if (e) {
        for (const cb of listeners.eaError) cb({ ...e, seenAt: clock.t });
        return { ok: false, signed: true, error: `search reported success: false (status ${e.status})`, latencyMs: 5 };
      }
      const found = opts.results?.(n) ?? [];
      for (const a of found) seen.set(a.tradeId, a);
      for (const cb of listeners.auctions) cb(found);
      return { ok: true, signed: true, latencyMs: 5 };
    },
    buy: async (tradeId, price) => {
      h.buys.push([tradeId, price]);
      return { ok: true, signed: true, latencyMs: 5 };
    },
    list: async (tradeId, start, bin) => {
      h.lists.push([tradeId, start, bin]);
      return { ok: true, signed: true, latencyMs: 5 };
    },
    onAuctions: subscribe(listeners.auctions),
    onBuyable: () => () => undefined,
    onProbe: () => () => undefined,
    onShape: () => () => undefined,
    onEaError: subscribe(listeners.eaError),
  };
  if (!opts.noBidding) {
    adapter.bid = async (tradeId, price, card) => {
      h.bids.push([tradeId, price, card]);
      if (opts.bidEaError) for (const cb of listeners.eaError) cb({ ...opts.bidEaError, seenAt: clock.t });
      const result = opts.bidResult?.(tradeId, price) ?? { ok: true, signed: true, latencyMs: 5 };
      const a = seen.get(tradeId) ?? ea.get(tradeId)?.a;
      if ((result.ok || result.error === 'timeout_unknown') && a) ea.set(tradeId, { a, bidState: 'highest', tradeState: 'active', currentBid: price });
      return result;
    };
    adapter.watchlist = async () => {
      h.reads++;
      opts.beforeRead?.(h.reads, ea, clock.t);
      const replaced = opts.watchlistResult?.(h.reads);
      if (replaced) return replaced;
      const watched: WatchedAuction[] = [...ea.values()].map(({ a, bidState, tradeState, currentBid }) => ({
        tradeId: a.tradeId,
        itemId: a.itemId ?? null,
        resourceId: a.resourceId,
        assetId: a.assetId,
        rating: a.rating,
        bidState,
        tradeState,
        currentBid,
        startingBid: a.startingBid,
        buyNowPrice: a.buyNow,
        expires: Math.round((a.expiresAt! - clock.t) / SEC),
      }));
      return { ok: true, signed: true, watched, latencyMs: 5 };
    };
    adapter.move = async (tradeId) => {
      h.moves.push(tradeId);
      ea.delete(tradeId);
      return { ok: true, signed: true, latencyMs: 5 };
    };
    adapter.clearExpired = async () => {
      h.clears.push(clock.t);
      const replaced = opts.clearResult?.();
      if (replaced) return replaced;
      let cleared = 0;
      for (const [id, e] of ea) {
        if (e.tradeState === 'expired' || (e.tradeState === 'closed' && e.bidState !== 'highest')) {
          ea.delete(id);
          cleared++;
        }
      }
      return { ok: true, signed: true, latencyMs: 5, cleared };
    };
  }

  const deps: SniperDeps = {
    adapter,
    getFilters: () => [{ id: 'f1', name: 'Target', filter: opts.filter ?? { resourceId: 100, maxPrice: 12_500 } }],
    estimateSellPrice: async () => null,
    credits: opts.credits,
    killSwitch: () => ({ active: opts.killSwitch?.active ?? false }),
    exclusive: opts.exclusive,
    ...(opts.budgetStore
      ? {
          loadBudget: async () => structuredClone(opts.budgetStore!.value),
          saveBudget: (b: BotBudgetState) => void (opts.budgetStore!.value = structuredClone(b)),
        }
      : {}),
    onAttempt: (a) => void h.attempts.push(a),
    onTrade: (t) => void h.trades.push(t),
    onChange: () => {
      if (h.sniper.state.phase === 'stopped') finished();
    },
    now: () => clock.t,
    random: () => 0,
    sleep: async (ms) => {
      h.notices.push(h.sniper.state.notice);
      h.statuses.push(h.sniper.getBidStatus());
      clock.t += ms;
      // By default it stops at the first wait after a search that is not its
      // turn to bid on that search's results (`paceEaRequest`).
      if (h.sniper.isRunning() && (opts.stopWhen?.(h) ?? (h.searches.length >= 1 && h.sniper.state.phase !== 'bidding'))) h.sniper.stop('manual');
      await Promise.resolve();
    },
  };
  h.sniper = new Sniper(deps, settings, modeSettings);
  return h;
}

describe('Bid mode — bidding', () => {
  it('bids the starting bid on an auction in its last minutes, searching by bid rather than buy-now price', async () => {
    const h = setup({ results: () => [auction('a', 180), auction('early', 360)] });
    h.sniper.start();
    await h.done();
    expect(h.bids).toEqual([['a', 10_000, { resourceId: 100, assetId: 100 }]]);
    // The max price is the max bid: searched as EA's maxBid, with no max buy-now.
    expect(h.searches[0]!.options).toEqual({ maxBid: 12_500 });
    expect(h.searches[0]!.filter).toEqual({ resourceId: 100 });
    expect(h.log()).toContain('Bid 10,000 on {card} (starting bid, 3 min left)');
    expect(h.log()).toContain(
      'Bot started in Bid mode: bids on auctions with 5 minutes or less left, up to 10 bids at a time, never above your max price',
    );
    expect(h.statuses.at(-1)).toEqual({ active: 1, max: 10, committed: 10_000 });
    // The watch list was read before anything else: Bid mode follows its bids there.
    expect(h.reads).toBeGreaterThanOrEqual(1);
  });

  it('bids one step of EA’s grid above the current bid', async () => {
    const h = setup({ results: () => [auction('a', 120, { currentBid: 11_000 })] });
    h.sniper.start();
    await h.done();
    expect(h.bids.map(([id, p]) => [id, p])).toEqual([['a', 11_250]]);
  });

  it('re-bids when outbid while the next step is at or under the max, then drops the auction', async () => {
    const h = setup({
      results: (n) => (n === 1 ? [auction('a', 80)] : []),
      beforeRead: (n, ea) => {
        const a = ea.get('a');
        if (!a) return;
        if (n === 2) Object.assign(a, { bidState: 'outbid', currentBid: 12_000 });
        if (n === 3) Object.assign(a, { bidState: 'outbid', currentBid: 12_500 });
      },
      stopWhen: (x) => x.log().some((m) => m.startsWith('Max bid reached')),
    });
    h.sniper.start();
    await h.done();
    expect(h.bids.map(([id, p]) => [id, p])).toEqual([
      ['a', 10_000],
      ['a', 12_250],
    ]);
    expect(h.log()).toEqual(
      expect.arrayContaining([
        'Bid 10,000 on {card} (starting bid, 1 min left)',
        'Outbid on {card} at 12,000 — re-bidding 12,250',
        'Max bid reached on {card} — dropping it | the next bid would be 12,750, your max is 12,500',
      ]),
    );
    // Dropped: a miss, its coins back, and never bid on again.
    expect(h.sniper.getStats().failures).toBe(1);
    expect(h.sniper.getGovernor()!.snapshot().coinFlowLastHour).toBe(0);
    expect(h.attempts.at(-1)).toMatchObject({ tradeId: 'a', outcome: 'failed', errorCode: 'max_bid_reached' });
  });

  it('buys with Buy Now when the buy-now price is at or under the max, instead of bidding', async () => {
    const h = setup({ results: () => [auction('cheap', 1_200, { buyNow: 12_000 })] });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual([['cheap', 12_000]]);
    expect(h.bids).toEqual([]);
    expect(h.sniper.getStats()).toMatchObject({ purchases: 1, coinsSpent: 12_000 });
  });

  it('holds no more than the max open bids, and searches again only once one frees', async () => {
    const h = setup({
      bidding: { maxActiveBids: 2 },
      // Ending beyond the guard window, so the first bid does not hold the
      // second search back.
      results: () => [auction('a', 150), auction('b', 180), auction('c', 210), auction('d', 240)],
      stopWhen: (x) => x.clock.t > START + 2 * MIN,
    });
    h.sniper.start();
    await h.done();
    // One new bid per search: two searches fill the two open bids, then none.
    expect(h.bids.map(([id]) => id)).toEqual(['a', 'b']);
    expect(h.searches).toHaveLength(2);
    expect(h.statuses.at(-1)).toEqual({ active: 2, max: 2, committed: 20_000 });
  });

  it('checks the minimum profit at the bid, as for a buy', async () => {
    const h = setup({
      settings: {
        thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 1_000 },
        autoSell: { ...DEFAULT_BOT_SETTINGS.autoSell, mode: 'fixed', fixedPrice: 11_000 },
      },
      results: () => [auction('thin', 60), auction('fat', 120, { startingBid: 9_000 })],
      // The cheaper bid goes first; the other is tried on the next search.
      stopWhen: (x) => x.searches.length >= 2 && x.sniper.state.phase !== 'bidding',
    });
    h.sniper.start();
    await h.done();
    // 11,000 less EA's 5% is 10,450: 450 over a 10,000 bid, 1,450 over 9,000.
    expect(h.bids.map(([id, p]) => [id, p])).toEqual([['fat', 9_000]]);
    expect(h.log()).toContain('not bidding 10,000 coins: estimated profit 450 coins is under your minimum profit (1,000 coins)');
  });

  it('takes the bids an hour limit, saying so', async () => {
    const h = setup({
      bidding: { maxBidsPerHour: 2 },
      results: () => [auction('a', 150), auction('b', 180), auction('c', 210)],
      stopWhen: (x) => x.searches.length >= 3 && x.sniper.state.phase !== 'bidding',
    });
    h.sniper.start();
    await h.done();
    expect(h.bids.map(([id]) => id)).toEqual(['a', 'b']);
    expect(h.notices.find((n) => n)).toMatch(/^Bidding paused: bid limit \(2 of 2 bids in the last hour\) — resumes about \d{1,2}:\d\d/);
  });
});

describe('Bid mode — the search results', () => {
  it('keeps auctions it leads out of them, and shows each lost lead once: for a re-bid, or over the max', async () => {
    const h = setup({
      // The same auction on every search, ending beyond the guard window so
      // the bot keeps searching while it leads.
      results: () => [auction('a', 200)],
      beforeRead: (n, ea) => {
        const a = ea.get('a');
        if (!a) return;
        if (n === 2) Object.assign(a, { bidState: 'outbid', currentBid: 12_000 });
        if (n === 3) Object.assign(a, { bidState: 'outbid', currentBid: 12_500 });
      },
      stopWhen: (x) => x.log().some((m) => m.startsWith('Max bid reached')),
    });
    h.sniper.start();
    await h.done();
    const results = [...h.sniper.getSearchResults()].reverse();
    // Found by the first search only: while it leads, later searches leave it out.
    expect(results.filter((r) => r.filterName !== 'Outbid' && r.matches.some((m) => m.tradeId === 'a'))).toHaveLength(1);
    expect(h.searches.length).toBeGreaterThan(1);
    expect(results.filter((r) => r.filterName === 'Outbid').map((r) => r.matches)).toEqual([
      [expect.objectContaining({ tradeId: 'a', bid: 12_250, outbid: 'rebid' })],
      [expect.objectContaining({ tradeId: 'a', bid: 12_750, outbid: 'over_max' })],
    ]);
  });
});

describe('Bid mode — pace', () => {
  it('sends EA one request at a time, searches a search delay apart, and one new bid per search', async () => {
    // Live, three bids sent within a second of a search drew EA's 521, 429
    // and 512: a burst no person makes.
    const bidTimes: number[] = [];
    const readTimes: number[] = [];
    const h: Harness = setup({
      results: () => [auction('a', 150), auction('b', 180), auction('c', 210)],
      bidResult: () => {
        bidTimes.push(h.clock.t);
        return { ok: true, signed: true, latencyMs: 5 };
      },
      beforeRead: (_n, _ea, now) => void readTimes.push(now),
      stopWhen: (x) => x.bids.length >= 3 && x.sniper.state.phase !== 'bidding',
    });
    h.sniper.start();
    await h.done();
    expect(h.bids.map(([id]) => id)).toEqual(['a', 'b', 'c']);
    expect(h.searches).toHaveLength(3);
    const requests = [...h.searchTimes, ...bidTimes, ...readTimes].sort((x, y) => x - y);
    const gaps = requests.slice(1).map((t, i) => t - requests[i]!);
    // Never two at once: after a watch list read the next request waits the
    // quick gap, 40% of the test's 10 s search delay.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(4 * SEC);
    // Searches keep the full search delay between them...
    const searchGaps = h.searchTimes.slice(1).map((t, i) => t - h.searchTimes[i]!);
    expect(Math.min(...searchGaps)).toBeGreaterThanOrEqual(10 * SEC);
    // ...and each bid waits its turn after the search that found it.
    for (const t of bidTimes) expect(t - Math.max(...h.searchTimes.filter((s) => s < t))).toBeGreaterThanOrEqual(10 * SEC);
  });

  it('says searches and bids when EA limits Bid mode', async () => {
    const h = setup({
      settings: { searchDelay: { min: 1, max: 1 } },
      searchEaError: () => ({ status: 512, category: 'rate_limited', endpoint: 'market' }),
      stopWhen: (x) => x.log().some((m) => m.startsWith('EA limited')),
    });
    h.sniper.start();
    await h.done();
    expect(h.log()).toContain('Searching and bidding at half your normal speed for the next 15 minutes so EA\'s limit can reset');
    expect(h.log()).toContain(
      'EA limited your searches and bids 3 times in 10 minutes (error 512): resting 15 min to protect your account, then searching and bidding at a third of your normal speed',
    );
  });
});

describe('Bid mode — what it wins', () => {
  const won = (n: number, ea: Map<string, EaAuction>) => {
    const a = ea.get('w');
    if (a && n === 2) Object.assign(a, { tradeState: 'closed', bidState: 'highest' });
  };

  it('with auto-sell on, moves a won card to the transfer list and lists it like a sniped card', async () => {
    const h = setup({
      settings: { autoSell: { ...DEFAULT_BOT_SETTINGS.autoSell, enabled: true, mode: 'fixed', fixedPrice: 15_000 } },
      results: (n) => (n === 1 ? [auction('w', 60)] : []),
      beforeRead: won,
      stopWhen: (x) => x.lists.length > 0,
    });
    h.sniper.start();
    await h.done();
    expect(h.moves).toEqual(['w']);
    expect(h.lists).toEqual([['w', 14_750, 15_000]]);
    expect(h.log()).toContain('Won {card} for 10,000');
    expect(h.sniper.getLog().find((e) => e.kind === 'listed')).toMatchObject({ price: 15_000, message: 'your fixed price' });
    // Counted exactly like a Buy Now snipe: Bought, Coins spent (the winning
    // bid), Profit at the auto-sell price after EA's 5% (15,000 → 14,250,
    // less 10,000) and Top snipes.
    expect(h.sniper.getStats()).toMatchObject({ purchases: 1, coinsSpent: 10_000, profit: 4_250 });
    expect(h.sniper.getStats().topSnipes).toEqual([expect.objectContaining({ kind: 'won', price: 10_000, sellPrice: 15_000, profit: 4_250 })]);
    // A purchase like a snipe: the attempt, and the trade the sale tracking follows.
    expect(h.attempts.find((a) => a.outcome === 'success')).toMatchObject({ tradeId: 'w', targetPrice: 10_000 });
    expect(h.trades).toEqual([{ tradeId: 'w', resourceId: 100, buyPrice: 10_000, itemId: 'item-w', assetId: 100, rating: 85 }]);
    // Its coins stay spent.
    expect(h.sniper.getGovernor()!.snapshot().coinFlowLastHour).toBe(10_000);
  });

  it('with auto-sell off, keeps a won card: moved to the transfer list, not listed', async () => {
    const h = setup({
      results: (n) => (n === 1 ? [auction('w', 60)] : []),
      beforeRead: won,
      stopWhen: (x) => x.moves.length > 0,
    });
    h.sniper.start();
    await h.done();
    expect(h.moves).toEqual(['w']);
    expect(h.lists).toEqual([]);
    expect(h.log()).toContain('Moved {card} to your transfer list');
  });

  it('leaves a won card in the watch list, saying why, when it cannot be moved', async () => {
    const h = setup({
      results: (n) => (n === 1 ? [auction('w', 60)] : []),
      beforeRead: won,
      stopWhen: (x) => x.log().some((m) => m.includes('stays in your watch list')),
    });
    // The promise shape has no move call.
    (h.sniper as unknown as { deps: SniperDeps }).deps.adapter.move = async () => ({ ok: false, signed: true, error: 'move_unsupported', latencyMs: 1 });
    h.sniper.start();
    await h.done();
    expect(h.log()).toContain('{card} stays in your watch list: Nova AI cannot move cards on this EA web app');
  });

  it('moves and lists several wins one step at a time, each a search delay after the last request', async () => {
    const times: number[] = [];
    const h: Harness = setup({
      settings: { autoSell: { ...DEFAULT_BOT_SETTINGS.autoSell, enabled: true, mode: 'fixed', fixedPrice: 15_000 } },
      bidding: { maxActiveBids: 3 },
      results: (n) => (n <= 3 ? [auction('w1', 200), auction('w2', 210), auction('w3', 220)] : []),
      // All three end on the bot's bid by the same read.
      beforeRead: (_n, ea) => {
        if (ea.size === 3) for (const a of ea.values()) Object.assign(a, { tradeState: 'closed', bidState: 'highest' });
      },
      stopWhen: (x) => x.lists.length >= 3,
    });
    const adapter = (h.sniper as unknown as { deps: SniperDeps }).deps.adapter;
    const move = adapter.move!;
    const list = adapter.list;
    adapter.move = (id) => (times.push(h.clock.t), move(id));
    adapter.list = (id, s, b) => (times.push(h.clock.t), list(id, s, b));
    h.sniper.start();
    await h.done();
    expect(h.moves).toEqual(['w1', 'w2', 'w3']);
    expect(h.lists.map(([id]) => id)).toEqual(['w1', 'w2', 'w3']);
    // Six requests, never two within the 10 s search delay.
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10 * SEC);
  });

  it('tries a listing EA refused again on a later turn', async () => {
    let refusals = 1;
    const h = setup({
      settings: { autoSell: { ...DEFAULT_BOT_SETTINGS.autoSell, enabled: true, mode: 'fixed', fixedPrice: 15_000 } },
      results: (n) => (n === 1 ? [auction('w', 60)] : []),
      beforeRead: won,
      stopWhen: (x) => x.log().some((m) => m.includes('listed for') || m.startsWith('not listed')) || x.lists.length >= 2,
    });
    const adapter = (h.sniper as unknown as { deps: SniperDeps }).deps.adapter;
    const list = adapter.list;
    adapter.list = async (id, s, b) => {
      if (refusals-- > 0) {
        h.lists.push([id, s, b]);
        return { ok: false, signed: true, error: 'list reported success: false (status 512)', latencyMs: 5 };
      }
      return list(id, s, b);
    };
    h.sniper.start();
    await h.done();
    expect(h.lists.map(([id]) => id)).toEqual(['w', 'w']);
    expect(h.sniper.getLog().find((e) => e.kind === 'listed')).toMatchObject({ price: 15_000 });
    // The refusal that was tried again is not in the log as a failure.
    expect(h.log().some((m) => m.startsWith('not listed'))).toBe(false);
  });

  it('counts a lost auction as a miss and gives its coins back', async () => {
    const h = setup({
      results: (n) => (n === 1 ? [auction('l', 60)] : []),
      beforeRead: (n, ea) => {
        const a = ea.get('l');
        if (a && n === 2) Object.assign(a, { tradeState: 'closed', bidState: 'outbid', currentBid: 13_000 });
      },
      stopWhen: (x) => x.reads >= 2,
    });
    h.sniper.start();
    await h.done();
    expect(h.log()).toContain('Lost {card} to a higher bid | it went for 13,000');
    expect(h.sniper.getStats().failures).toBe(1);
    expect(h.attempts.at(-1)).toMatchObject({ tradeId: 'l', outcome: 'too_slow', errorCode: 'outbid' });
    expect(h.sniper.getGovernor()!.snapshot().coinFlowLastHour).toBe(0);
  });
});

describe('Bid mode — guards the bids it holds first', () => {
  // Live: with 12 of 12 bids open the bot read the watch list once a minute,
  // re-bid one search delay at a time and kept searching, and lost 10 leads
  // at once.

  it('with every open bid taken, stops searching and checks the watch list every few seconds', async () => {
    const readTimes: number[] = [];
    const waits: { t: number; phase: string }[] = [];
    const h = setup({
      bidding: { maxActiveBids: 1 },
      results: () => [auction('a', 200), auction('b', 210)],
      beforeRead: (_n, _ea, now) => void readTimes.push(now),
      stopWhen: (x) => {
        waits.push({ t: x.clock.t, phase: x.sniper.state.phase });
        return x.clock.t > START + 90 * SEC;
      },
    });
    h.sniper.start();
    await h.done();
    expect(h.bids.map(([id]) => id)).toEqual(['a']);
    expect(h.searches).toHaveLength(1);
    const bidAt = h.searchTimes[0]! + 10 * SEC;
    const after = readTimes.filter((t) => t > bidAt);
    const gaps = after.slice(1).map((t, i) => t - after[i]!);
    expect(after.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6 * SEC);
    // Its waits say it is checking the bids, never that a search is coming.
    expect(waits.filter((w) => w.t > bidAt && w.phase === 'waiting')).toEqual([]);
  });

  it('a bid near its end holds the search back until it is settled', async () => {
    const h = setup({
      bidding: { maxActiveBids: 5 },
      results: (n) => [auction('a', 45), auction(`late${n}`, 250)],
      beforeRead: (_n, ea, now) => {
        const a = ea.get('a');
        if (a && now >= a.a.expiresAt!) a.tradeState = 'closed';
      },
      stopWhen: (x) => x.clock.t > START + 2 * MIN,
    });
    h.sniper.start();
    await h.done();
    // The soonest-ending auction first, then nothing new until it is won.
    expect(h.bids[0]![0]).toBe('a');
    const bidAt = h.searchTimes[0]!;
    const end = START + 45 * SEC;
    expect(h.searchTimes.filter((t) => t > bidAt && t < end)).toEqual([]);
    expect(h.moves).toEqual(['a']);
    expect(h.searchTimes.filter((t) => t > end).length).toBeGreaterThan(0);
  });

  it('re-bids several outbid leads within seconds, soonest-ending first', async () => {
    const bidTimes: [string, number, number][] = [];
    let outbid = false;
    const h: Harness = setup({
      bidding: { maxActiveBids: 3 },
      results: (n) => (n <= 3 ? [auction(`x${n}`, 280 - n * 20)] : []),
      bidResult: (tradeId, price) => {
        bidTimes.push([tradeId, price, h.clock.t]);
        return { ok: true, signed: true, latencyMs: 5 };
      },
      beforeRead: (_n, ea) => {
        if (outbid || ea.size < 3) return;
        outbid = true;
        for (const a of ea.values()) Object.assign(a, { bidState: 'outbid', currentBid: 10_000 });
      },
      stopWhen: (x) => x.bids.length >= 6 && x.sniper.state.phase !== 'bidding',
    });
    h.sniper.start();
    await h.done();
    const rebids = bidTimes.slice(3);
    expect(rebids.map(([id, price]) => [id, price])).toEqual([
      ['x3', 10_250],
      ['x2', 10_250],
      ['x1', 10_250],
    ]);
    // The quick gap (40% of the 10 s search delay), not a search delay each.
    const gaps = rebids.slice(1).map(([, , t], i) => t - rebids[i]![2]);
    expect(gaps).toEqual([4 * SEC, 4 * SEC]);
  });

  it('a rest that is due lets the open bids finish first, with no new bids', async () => {
    const waits: { t: number; phase: string }[] = [];
    const h = setup({
      settings: { rest: { enabled: true, minutes: { min: 10, max: 10 }, afterMinutes: { min: 1, max: 1 } } },
      results: (n) => (n === 1 ? [auction('a', 150)] : [auction(`b${n}`, 280)]),
      beforeRead: (_n, ea, now) => {
        for (const a of ea.values()) if (now >= a.a.expiresAt!) a.tradeState = 'closed';
      },
      stopWhen: (x) => {
        waits.push({ t: x.clock.t, phase: x.sniper.state.phase });
        return x.sniper.state.phase === 'rest';
      },
    });
    h.sniper.start();
    await h.done();
    const restDue = START + MIN;
    // No search starts once the rest is due (one already waiting its turn
    // then may still go out) ...
    expect(h.searchTimes.filter((t) => t > restDue + 10 * SEC)).toEqual([]);
    // ... and the rest only begins once every open bid was won.
    expect(h.moves).toEqual(h.bids.map(([id]) => id));
    const lastEnd = Math.max(...h.bids.map(([id]) => h.ea.get(id)?.a.expiresAt ?? START + 280 * SEC));
    expect(waits.find((w) => w.phase === 'rest')!.t).toBeGreaterThanOrEqual(Math.min(lastEnd, START + 280 * SEC));
  });

});

describe('Bid mode — keeps the watch list clear', () => {
  // Live: "Your EA watch list is full (50 cards): no new bids until there is
  // room", with the trader clearing expired items by hand.
  const finished = (id: string, tradeState: 'closed' | 'expired'): EaAuction => ({
    a: auction(id, 0),
    bidState: tradeState === 'closed' ? 'outbid' : 'none',
    tradeState,
    currentBid: 15_000,
  });
  const running = (id: string): EaAuction => ({ a: auction(id, 3_000), bidState: 'none', tradeState: 'active', currentBid: 0 });

  it('clears expired and lost items when the session starts, never a won one', async () => {
    const h = setup({ results: () => [] });
    h.ea.set('lost', finished('lost', 'closed'));
    h.ea.set('old', finished('old', 'expired'));
    h.ea.set('won', { ...finished('won', 'closed'), bidState: 'highest' });
    h.sniper.start();
    await h.done();
    // Right after the first watch list read (its quick gap), before any search.
    expect(h.clears).toEqual([START + 4 * SEC]);
    expect(h.searchTimes.every((t) => t > h.clears[0]!)).toBe(true);
    expect([...h.ea.keys()]).toEqual(['won']);
    expect(h.log()).toContain('Cleared 2 expired items from your watch list (Transfer Targets)');
  });

  it('keeps clearing every few minutes while it runs', async () => {
    const h = setup({
      bidding: { windowMinutes: 60, maxActiveBids: 1 },
      results: () => [auction('a', 600)],
      beforeRead: (_n, ea, now) => {
        if (now >= START + MIN && !ea.has('x1') && h.clears.length === 0) ea.set('x1', finished('x1', 'closed'));
        if (now >= START + 2 * MIN && h.clears.length === 1 && !ea.has('x2')) ea.set('x2', finished('x2', 'expired'));
      },
      stopWhen: (x) => x.clock.t > START + 8 * MIN,
    });
    h.sniper.start();
    await h.done();
    expect(h.clears).toHaveLength(2);
    expect(h.clears[0]!).toBeGreaterThanOrEqual(START + MIN);
    // The next one waits its five minutes.
    expect(h.clears[1]! - h.clears[0]!).toBeGreaterThanOrEqual(5 * MIN);
    expect(h.ea.has('x1')).toBe(false);
    expect(h.ea.has('x2')).toBe(false);
  });

  it('clears at once when the watch list is nearly full', async () => {
    let filled = false;
    const h = setup({
      bidding: { windowMinutes: 60, maxActiveBids: 1 },
      results: () => [auction('a', 600)],
      beforeRead: (_n, ea, now) => {
        if (now < START + MIN || filled) return;
        filled = true;
        for (let i = 0; i < 40; i++) ea.set(`r${i}`, running(`r${i}`));
        ea.set('late', finished('late', 'expired'));
      },
      stopWhen: (x) => x.clock.t > START + 3 * MIN,
    });
    h.ea.set('old', finished('old', 'expired'));
    h.sniper.start();
    await h.done();
    // At the start, then as soon as the list neared 50, well within five minutes.
    expect(h.clears).toHaveLength(2);
    expect(h.clears[1]! - h.clears[0]!).toBeLessThan(2 * MIN);
    expect(h.ea.has('late')).toBe(false);
  });

  it('says once when the page cannot clear, and keeps bidding', async () => {
    const h = setup({
      results: () => [auction('a', 180)],
      clearResult: () => ({ ok: false, signed: true, latencyMs: 5, error: 'window.services.Item.untarget is not a function' }),
    });
    h.ea.set('old', finished('old', 'expired'));
    h.sniper.start();
    await h.done();
    expect(h.clears).toHaveLength(1);
    expect(h.log().filter((m) => m.startsWith('Could not clear the expired items'))).toEqual([
      'Could not clear the expired items from your watch list: window.services.Item.untarget is not a function',
    ]);
    expect(h.bids.map(([id]) => id)).toEqual(['a']);
  });
});

describe('Bid mode — coins its bids hold', () => {
  const two = () => [auction('a', 150, { startingBid: 10_000 }), auction('b', 180, { startingBid: 12_000 })];
  // One new bid per search: the second auction is tried on the second search.
  const secondSearchDone = (x: Harness) => x.searches.length >= 2 && x.sniper.state.phase !== 'bidding';

  it('counts them against the session coin budget', async () => {
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 0, sessionCoinBudget: 20_000 } },
      results: two,
      stopWhen: secondSearchDone,
    });
    h.sniper.start();
    await h.done();
    expect(h.bids.map(([id]) => id)).toEqual(['a']);
    expect(h.log()).toContain('not bidding 12,000 coins: it would go over your session coin budget (10,000 coins are held in your other bids)');
  });

  it('counts them against the coins EA says the trader has', async () => {
    const h = setup({ credits: () => 20_000, results: two, stopWhen: secondSearchDone });
    h.sniper.start();
    await h.done();
    expect(h.bids.map(([id]) => id)).toEqual(['a']);
    expect(h.log()).toContain('not bidding 12,000 coins: not enough coins (10,000 coins free after your other bids)');
  });

  it('holds them in the governor’s coin flow while they stand, and frees them when outbid', async () => {
    const h = setup({
      settings: { safety: { ...DEFAULT_BOT_SETTINGS.safety, maxSearchesPerHour: 7_200, buyToSearchRatio: 1, cooldownSeconds: 0, maxCoinFlowPerHour: 20_000 } },
      filter: { resourceId: 100, maxPrice: 12_000 },
      results: (n) => (n <= 2 ? two() : []),
      beforeRead: (n, ea) => {
        const a = ea.get('a');
        if (a && n === 3) Object.assign(a, { bidState: 'outbid', currentBid: 12_000 });
      },
      stopWhen: (x) => x.reads >= 3,
    });
    h.sniper.start();
    await h.done();
    // 10,000 held, so 12,000 more would pass the 20,000 an hour.
    expect(h.bids.map(([id]) => id)).toEqual(['a']);
    expect(h.notices.find((n) => n)).toMatch(/^Bidding paused: coin-flow limit \(10,000 of 20,000 coins in the last hour\)/);
    // Outbid (and the next bid is over the max): its coins come back.
    expect(h.sniper.getGovernor()!.snapshot().coinFlowLastHour).toBe(0);
  });
});

describe('Bid mode — fails closed', () => {
  it('refuses to start without the calls to bid and read the watch list', () => {
    const h = setup({ noBidding: true });
    h.sniper.start();
    expect(h.sniper.isRunning()).toBe(false);
    expect(h.sniper.state).toMatchObject({
      stopReason: 'bid_unavailable',
      stopDetail: "Bid mode needs to bid and read your watch list through EA's web app, and this page does not let Nova AI do that — use Snipe mode",
    });
  });

  it('stops, bidding nothing, when the page cannot read the watch list for Nova AI', async () => {
    const h = setup({
      results: () => [auction('a', 60)],
      watchlistResult: () => ({ ok: false, signed: true, error: 'bidding_unsupported', latencyMs: 1 }),
    });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('bid_unavailable');
    expect(h.searches).toHaveLength(0);
    expect(h.bids).toHaveLength(0);
  });

  it('does not start bidding when the first watch list read fails', async () => {
    const h = setup({ results: () => [auction('a', 60)], watchlistResult: () => ({ ok: false, error: 'timed out waiting for adapter response', latencyMs: 15_000 }) });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state).toMatchObject({
      stopReason: 'watchlist_failing',
      stopDetail: 'Nova AI could not read your EA watch list, which Bid mode needs to follow its bids — try Start again in a moment',
    });
    expect(h.log()).toContain('Could not read your watch list: timed out waiting for adapter response');
    expect(h.bids).toHaveLength(0);
  });

  it('stops when later reads keep failing', async () => {
    const h = setup({
      results: (n) => (n === 1 ? [auction('a', 200)] : []),
      watchlistResult: (n) => (n === 1 ? undefined : { ok: false, signed: true, error: 'requestWatchedItems reported success: false', latencyMs: 1 }),
      stopWhen: () => false,
    });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('watchlist_failing');
    expect(h.reads).toBe(4);
  });

  it('refuses to start without a max price: it is the max bid', () => {
    const h = setup({ filter: { resourceId: 100 } });
    h.sniper.start();
    expect(h.sniper.state).toMatchObject({
      stopReason: 'no_max_bid',
      stopDetail: 'set a max price in Search first: in Bid mode it is the most Nova AI bids for a player',
    });
  });

  it('stops when EA’s watch list is full and none of its bids is left to follow', async () => {
    const full = Array.from({ length: 50 }, (_, i) => auction(`x${i}`, 3_000));
    const h = setup({
      results: () => [auction('a', 60)],
      beforeRead: (n, ea) => {
        if (n === 1) for (const a of full) ea.set(a.tradeId, { a, bidState: 'outbid', tradeState: 'active', currentBid: 15_000 });
      },
    });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state).toMatchObject({ stopReason: 'watchlist_full' });
    expect(h.bids).toHaveLength(0);
  });

  it('says EA keeps the open bids when the bot stops', async () => {
    const h = setup({ results: () => [auction('a', 60)] });
    h.sniper.start();
    await h.done();
    expect(h.log()[0]).toBe('1 bid still open: EA keeps bids until their auctions end, and Bid mode follows them again when you start it');
  });

  it('a bid EA refuses is not retried, gives its coins back and says why', async () => {
    const h = setup({
      results: () => [auction('a', 60)],
      bidResult: () => ({ ok: false, signed: true, error: 'bid reported success: false (status 461)', latencyMs: 5 }),
      stopWhen: (x) => x.searches.length >= 2,
    });
    h.sniper.start();
    await h.done();
    expect(h.bids).toHaveLength(1);
    expect(h.log()).toContain('Bid 10,000 on {card} not accepted: someone else bid first, or the auction ended');
    expect(h.attempts.at(-1)).toMatchObject({ outcome: 'too_slow' });
    expect(h.sniper.getGovernor()!.snapshot().coinFlowLastHour).toBe(0);
  });

  it('follows a bid EA did not answer in time: the watch list settles it', async () => {
    const h = setup({
      results: (n) => (n === 1 ? [auction('a', 60)] : []),
      bidResult: () => ({ ok: false, signed: true, error: 'timeout_unknown', latencyMs: 12_000 }),
      stopWhen: (x) => x.reads >= 2,
    });
    h.sniper.start();
    await h.done();
    expect(h.log()).toContain('No answer from EA in time for the 10,000 bid on {card}: the next watch list check will tell');
    // Held while unknown, and confirmed leading by the read.
    expect(h.statuses.at(-1)).toEqual({ active: 1, max: 10, committed: 10_000 });
    expect(h.sniper.getLog().some((e) => e.kind === 'dropped')).toBe(false);
  });
});

describe('Bid mode — the same rails as Snipe mode', () => {
  it('backs off, slows down, rests and stops for EA’s rate limits exactly as Snipe mode does', async () => {
    const h = setup({
      settings: { searchDelay: { min: 1, max: 1 } },
      searchEaError: () => ({ status: 429, category: 'rate_limited', endpoint: 'market' }),
      stopWhen: () => false,
    });
    h.sniper.start();
    await h.done();
    const gaps = h.searchTimes.slice(1).map((t, i) => (t - h.searchTimes[i]!) / SEC);
    expect(gaps).toEqual([5, 10, 900, 5, 10, 1800, 5, 10]);
    expect(h.sniper.state.stopReason).toBe('ea_rate_limited');
  });

  it('backs off when EA rate-limits a bid', async () => {
    const h = setup({
      results: (n) => (n === 1 ? [auction('a', 200), auction('b', 220)] : []),
      bidEaError: { status: 429, category: 'rate_limited', endpoint: 'bid' },
      bidResult: () => ({ ok: false, signed: true, error: 'bid reported success: false (status 429)', latencyMs: 5 }),
      stopWhen: (x) => x.clock.t > START + 30 * SEC,
    });
    h.sniper.start();
    await h.done();
    expect(h.log()).toContain('EA says too many requests (error 429): waiting 5 s before the next search');
    // The rest of that search's auctions wait for the backoff.
    expect(h.bids.map(([id]) => id)).toEqual(['a']);
  });

  it('counts every bid in the governor’s actions an hour, raised by the bids an hour', async () => {
    const bid = setup({ results: () => [auction('a', 60)] });
    bid.sniper.start();
    await bid.done();
    expect(bid.sniper.getGovernor()!.getSettings().actionsPerHour).toBe(7_200 + 15 + 60);

    const snipe = setup({ mode: 'snipe' });
    snipe.sniper.start();
    await snipe.done();
    expect(snipe.sniper.getGovernor()!.getSettings().actionsPerHour).toBe(7_200 + 15);
  });

  it('stops for the server kill switch before its next bid or watch list read', async () => {
    const killSwitch = { active: false };
    const h = setup({
      killSwitch,
      results: () => [auction('a', 200), auction('b', 220)],
      stopWhen: (x) => {
        killSwitch.active = x.bids.length > 0;
        return false;
      },
    });
    h.sniper.start();
    await h.done();
    expect(h.sniper.state.stopReason).toBe('kill_switch');
    // Bids go one at a time, each after a wait: the switch stops the second.
    expect(h.bids.map(([id]) => id)).toEqual(['a']);
    expect(h.searches).toHaveLength(1);
    expect(h.reads).toBe(1);
  });

  it('never reads the watch list or bids from a tab without the engine lease', async () => {
    const h = setup({ exclusive: () => false, results: () => [auction('a', 60)] });
    h.sniper.start();
    expect(h.sniper.state.stopReason).toBe('other_tab');
    expect(h.reads).toBe(0);
    expect(h.bids).toHaveLength(0);
  });

  it('saves its bids in the hourly budgets, so Stop/Start and a reload never refill them', async () => {
    const budgetStore = { value: null as BotBudgetState | null };
    const h = setup({ results: () => [auction('a', 60)], budgetStore });
    h.sniper.start();
    await h.done();
    expect(budgetStore.value?.bidTimes).toHaveLength(1);
  });
});

describe('Snipe mode is unchanged', () => {
  it('never reads the watch list or bids, and searches by max buy-now price', async () => {
    const h = setup({ mode: 'snipe', results: () => [auction('a', 60, { buyNow: 9_000 })] });
    h.sniper.start();
    await h.done();
    expect(h.reads).toBe(0);
    expect(h.bids).toEqual([]);
    expect(h.searches[0]!.options).toBeUndefined();
    expect(h.searches[0]!.filter).toEqual({ resourceId: 100, maxPrice: 12_500 });
    expect(h.buys).toEqual([['a', 9_000]]);
  });
});

describe('plain reasons', () => {
  it('says why a bid or a move did not go through, in plain words', () => {
    expect(bidMissReason('bid reported success: false (status 478)')).toBe('someone else bid first, or the auction ended');
    expect(bidMissReason('bid reported success: false (status 470)')).toBe('not enough coins');
    expect(bidMissReason('price_mismatch')).toBe('the bid had changed');
    expect(bidMissReason('weird')).toBe('EA did not accept the bid');
    expect(moveMissReason('move_unsupported')).toBe('Nova AI cannot move cards on this EA web app');
    expect(moveMissReason('move reported success: false (status 473)')).toBe('EA refused the move (error 473): your transfer list may be full');
  });
});
