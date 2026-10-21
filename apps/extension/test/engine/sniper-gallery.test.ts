// Nova AI's Gallery mode (`engine/sniper.ts`, `runGallery`; rules in
// `engine/gallery.ts`): the trader's list, one card at a time. A card's
// version comes from a look-only search when the rating is not the player's
// base card's; it is bought under its market price for two minutes, then at
// the market price and a step more after each search that found none, up to
// 10% over it (past that it is skipped); a bought card goes to the club, to
// the transfer list and back on the market one step under its market price.
// The list's budget caps its buys, and its progress is saved after every
// change.
//
// A fake EA answers searches and the club/move/list calls; `sleep` advances
// a fake clock.

import { DEFAULT_BOT_MODE_SETTINGS, DEFAULT_BOT_SETTINGS, type BotSettings, type FilterCriteria, type GalleryCard, type GalleryState, type TrimmedAuction } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { Sniper, clubMissReason, type SniperDeps } from '../../src/engine/sniper.js';
import { ACT_ERROR } from '../../src/lib/act-auth.js';

import type { ActionOutcome } from '../../src/content/adapter-client.js';
import type { TradeInput } from '../../src/engine/types.js';

const START = 1_000_000;
const SEC = 1_000;

function listing(tradeId: string, buyNow: number, extra: Partial<TrimmedAuction> = {}): TrimmedAuction {
  return {
    tradeId,
    resourceId: 100,
    assetId: 100,
    rating: 85,
    buyNow,
    startingBid: 150,
    currentBid: 0,
    offers: 0,
    expiresAt: START + 3_600 * SEC,
    seenAt: START,
    ...extra,
  };
}

function card(extra: Partial<GalleryCard> = {}): GalleryCard {
  return { key: '100:85', name: 'Hugo Ekitiké', rating: 85, playerId: 100, resourceId: 100, status: 'todo', ...extra };
}

interface Opts {
  gallery?: GalleryState;
  settings?: Partial<BotSettings>;
  /** What the `n`th search (1 first) finds. Default: nothing. */
  results?: (n: number, filter: FilterCriteria) => TrimmedAuction[];
  /** Market prices by resourceId. Default: 4,000 on FUTBIN. */
  market?: (resourceId: number) => number | null;
  buyResult?: (tradeId: string) => ActionOutcome;
  clubResult?: () => ActionOutcome;
  noClub?: boolean;
  /** Searches before the test stops the bot. */
  maxSearches?: number;
}

function setup(opts: Opts = {}) {
  const settings: BotSettings = {
    ...DEFAULT_BOT_SETTINGS,
    riskAcknowledgedAt: '2026-09-24T00:00:00.000Z',
    searchDelay: { min: 10, max: 10 },
    breaks: { ...DEFAULT_BOT_SETTINGS.breaks, enabled: false },
    rest: { ...DEFAULT_BOT_SETTINGS.rest, enabled: false },
    thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 0 },
    safety: { ...DEFAULT_BOT_SETTINGS.safety, maxSearchesPerHour: 7_200, buyToSearchRatio: 1, cooldownSeconds: 0, maxBuysPerHour: 100 },
    ...opts.settings,
  };
  const clock = { t: START };
  const auctions = new Set<(a: TrimmedAuction[]) => void>();
  let finished!: () => void;
  const stopped = new Promise<void>((r) => (finished = r));
  const h = {
    sniper: null as unknown as Sniper,
    clock,
    searches: [] as { filter: FilterCriteria; at: number }[],
    buys: [] as [string, number, number][],
    calls: [] as string[],
    lists: [] as [string, number, number][],
    prices: [] as number[],
    trades: [] as TradeInput[],
    saved: [] as GalleryState[],
    log: () => h.sniper.getLog().map((e) => e.message),
    gallery: () => h.sniper.getGallery(),
    done: async () => {
      await stopped;
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
  const adapter: SniperDeps['adapter'] = {
    search: async (filter) => {
      h.searches.push({ filter, at: clock.t });
      const found = opts.results?.(h.searches.length, filter) ?? [];
      for (const cb of auctions) cb(found);
      return { ok: true, signed: true, latencyMs: 5 };
    },
    buy: async (tradeId, price) => {
      h.buys.push([tradeId, price, clock.t]);
      h.calls.push(`buy ${tradeId}`);
      return opts.buyResult?.(tradeId) ?? { ok: true, signed: true, latencyMs: 5 };
    },
    list: async (tradeId, start, bin) => {
      h.lists.push([tradeId, start, bin]);
      h.calls.push(`list ${tradeId}`);
      return { ok: true, signed: true, latencyMs: 5 };
    },
    move: async (tradeId) => {
      h.calls.push(`move ${tradeId}`);
      return { ok: true, signed: true, latencyMs: 5 };
    },
    onAuctions: (cb) => {
      auctions.add(cb);
      return () => auctions.delete(cb);
    },
    onBuyable: () => () => undefined,
    onProbe: () => () => undefined,
    onShape: () => () => undefined,
  };
  if (!opts.noClub)
    adapter.club = async (tradeId) => {
      h.calls.push(`club ${tradeId}`);
      return opts.clubResult?.() ?? { ok: true, signed: true, latencyMs: 5 };
    };
  const deps: SniperDeps = {
    adapter,
    getFilters: () => [],
    estimateSellPrice: async () => null,
    marketPrice: async (resourceId) => {
      h.prices.push(resourceId);
      const price = opts.market ? opts.market(resourceId) : 4_000;
      return price == null ? null : { price, source: 'futbin' };
    },
    saveGallery: (state) => void h.saved.push(state),
    killSwitch: () => ({ active: false }),
    onTrade: (t) => void h.trades.push(t),
    onChange: () => {
      if (h.sniper.state.phase === 'stopped') finished();
    },
    now: () => clock.t,
    random: () => 0,
    sleep: async (ms) => {
      clock.t += ms;
      if (h.sniper.isRunning() && h.searches.length >= (opts.maxSearches ?? 200)) h.sniper.stop('manual');
      await Promise.resolve();
    },
  };
  h.sniper = new Sniper(deps, settings, { ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' });
  h.sniper.setGallery(opts.gallery ?? { budget: 100_000, spent: 0, cards: [card()] });
  return h;
}

describe('Gallery mode — buying and listing', () => {
  it('buys a card under its market price, sends it to the club, moves it and lists it one step under the market price', async () => {
    // The minimum profit never holds a Gallery buy back: each one is bought to collect.
    const h = setup({ settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 5_000 } }, results: () => [listing('t1', 3_700)] });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]!.filter).toEqual({ resourceId: 100, minRating: 85, maxRating: 85, maxPrice: 3_900 });
    expect(h.calls).toEqual(['buy t1', 'club t1', 'move t1', 'list t1']);
    expect(h.lists).toEqual([['t1', 3_800, 3_900]]);
    expect(h.gallery()).toEqual({ budget: 100_000, spent: 3_700, cards: [card({ status: 'listed', price: 3_700, market: 4_000, listPrice: 3_900 })] });
    expect(h.trades).toEqual([{ tradeId: 't1', resourceId: 100, buyPrice: 3_700 }]);
    expect(h.sniper.state.stopReason).toBe('gallery_done');
    expect(h.log()).toContain('Sent {card} to your club');
    expect(h.log()).toContain('Gallery: one step under the market price (4,000 coins)');
    // Its progress was saved after every step.
    expect(h.saved.at(-1)).toEqual(h.gallery());
  });

  it('looks only under the market price for two minutes, then buys the cheapest at the market price', async () => {
    const h = setup({ results: () => [listing('t1', 4_000)] });
    h.sniper.start();
    await h.done();
    const [buy] = h.buys;
    expect(buy![1]).toBe(4_000);
    expect(buy![2]).toBeGreaterThanOrEqual(START + 120 * SEC);
    // Every search before that asked for less than the market price.
    for (const s of h.searches.slice(0, -1)) expect(s.filter.maxPrice).toBeLessThan(4_000);
    expect(h.searches.at(-1)!.filter.maxPrice).toBe(4_000);
    expect(h.log()).toContain('Gallery: none of {card} under its market price (4,000 coins) — buying the cheapest at or near it');
  });

  it('steps the price up while none is listed, and skips the card past 10% over its market price', async () => {
    const h = setup({ results: () => [listing('t1', 5_000)] });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual([]);
    const market = h.searches.filter((s) => (s.filter.maxPrice ?? 0) >= 4_000).map((s) => s.filter.maxPrice);
    expect(market).toEqual([4_000, 4_100, 4_200, 4_300, 4_400]);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'skipped', note: 'none listed within 10% of its market price (4,000 coins)' });
    expect(h.sniper.state.stopReason).toBe('gallery_done');
  });

  it("learns a special card's version with a look-only search, and never buys on that search", async () => {
    const special = (id: string, buyNow: number) => listing(id, buyNow, { resourceId: 50_000_100, rating: 88 });
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [card({ key: '100:88', rating: 88, resourceId: undefined })] },
      results: (n) => (n === 1 ? [special('cheap', 9_000)] : [special('t2', 9_500)]),
      market: (id) => (id === 50_000_100 ? 10_000 : null),
    });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]!.filter).toEqual({ resourceId: 100, minRating: 88, maxRating: 88 });
    expect(h.prices).toContain(50_000_100);
    // Not the one the look-only search saw; the next one, under 9,900.
    expect(h.buys.map(([id, price]) => [id, price])).toEqual([['t2', 9_500]]);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', resourceId: 50_000_100, market: 10_000, listPrice: 9_900 });
  });

  it('prices a card by the cheapest listing seen when FUTBIN and Nova have none', async () => {
    const h = setup({ market: () => null, results: (n) => (n === 1 ? [listing('t1', 3_000)] : [listing('t2', 2_900)]), gallery: { budget: 100_000, spent: 0, cards: [card()] } });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]!.filter.maxPrice).toBeUndefined();
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', market: 3_000, price: 2_900, listPrice: 2_900 });
  });

  it("buys a card at EA's lowest price straight at the market price: nothing lists under it", async () => {
    const h = setup({ market: () => 200, results: () => [listing('t1', 200)] });
    h.sniper.start();
    await h.done();
    expect(h.searches.map((s) => s.filter.maxPrice)).toEqual([200]);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', price: 200, listPrice: 200 });
  });

  it("keeps a budget-capped max on EA's price grid", async () => {
    const h = setup({ gallery: { budget: 4_050, spent: 0, cards: [card()] }, maxSearches: 1 });
    h.sniper.start();
    await h.done();
    // 3,900 under the market price, within the 4,050 left.
    expect(h.searches[0]!.filter.maxPrice).toBe(3_900);
    const tight = setup({ gallery: { budget: 1_337, spent: 0, cards: [card()] }, maxSearches: 1 });
    tight.sniper.start();
    await tight.done();
    expect(tight.searches[0]!.filter.maxPrice).toBe(1_300);
  });

  it('a card the club refuses still goes back on the market, and says why', async () => {
    const h = setup({
      results: () => [listing('t1', 3_700)],
      clubResult: () => ({ ok: false, signed: true, error: 'move to club did not report success: true', latencyMs: 5 }),
    });
    h.sniper.start();
    await h.done();
    expect(h.calls).toEqual(['buy t1', 'club t1', 'club t1', 'club t1', 'move t1', 'list t1']);
    expect(h.gallery().cards[0]).toMatchObject({
      status: 'listed',
      note: 'Not sent to your club (EA did not move it: your club may already hold this card): check the Set counted it',
    });
  });

  it('a buy EA did not answer in time is never bought twice: its late answer settles it', async () => {
    let first = true;
    const h = setup({
      results: () => [listing('t1', 3_700), listing('t2', 3_700)],
      buyResult: () => {
        if (!first) return { ok: true, signed: true, latencyMs: 5 };
        first = false;
        return { ok: false, signed: true, error: ACT_ERROR.timeoutUnknown, latencyMs: 15_000, late: Promise.resolve({ ok: true, signed: true, latencyMs: 16_000 }) };
      },
    });
    h.sniper.start();
    await h.done();
    expect(h.buys.map(([id]) => id)).toEqual(['t1']);
    expect(h.calls).toEqual(['buy t1', 'club t1', 'move t1', 'list t1']);
    expect(h.gallery().cards[0]!.status).toBe('listed');
  });
});

describe('Gallery mode — the budget and the list', () => {
  it('stops once the budget is spent', async () => {
    const h = setup({
      gallery: { budget: 3_800, spent: 0, cards: [card(), card({ key: '200:85', playerId: 200, resourceId: 200, name: 'Florian Wirtz' })] },
      results: (_n, f) => [listing(`t${f.resourceId}`, 3_700, { resourceId: f.resourceId, assetId: f.resourceId })],
    });
    h.sniper.start();
    await h.done();
    expect(h.buys.map(([id]) => id)).toEqual(['t100']);
    expect(h.sniper.state.stopReason).toBe('gallery_budget');
    expect(h.gallery().cards[1]!.status).toBe('todo');
  });

  it('skips a card that costs more than what is left of the budget', async () => {
    const h = setup({
      gallery: { budget: 5_000, spent: 0, cards: [card(), card({ key: '200:85', playerId: 200, resourceId: 200, name: 'Florian Wirtz' })] },
      results: (_n, f) => [listing(`t${f.resourceId}`, f.resourceId === 100 ? 3_700 : 4_000, { resourceId: f.resourceId, assetId: f.resourceId })],
    });
    h.sniper.start();
    await h.done();
    expect(h.buys.map(([id]) => id)).toEqual(['t100']);
    expect(h.gallery().cards[1]).toMatchObject({ status: 'skipped', note: 'it costs more than what is left of your Gallery budget (1,300 coins)' });
  });

  it('refuses to start without the club call, with no card left to buy, or with the budget spent', () => {
    const noClub = setup({ noClub: true });
    noClub.sniper.start();
    expect(noClub.sniper.state.stopReason).toBe('gallery_unavailable');
    const empty = setup({ gallery: { budget: 100_000, spent: 0, cards: [card({ status: 'listed' })] } });
    empty.sniper.start();
    expect(empty.sniper.state.stopReason).toBe('no_gallery');
    const broke = setup({ gallery: { budget: 1_000, spent: 900, cards: [card()] } });
    broke.sniper.start();
    expect(broke.sniper.state.stopReason).toBe('gallery_budget');
    for (const h of [noClub, empty, broke]) expect(h.searches).toEqual([]);
  });

  it('never buys a finished card again from the saved list', async () => {
    const h = setup({ results: () => [listing('t1', 3_700)] });
    h.sniper.start();
    await h.done();
    const again = setup({ results: () => [listing('t9', 3_700)], gallery: h.saved.at(-1)! });
    again.sniper.start();
    expect(again.sniper.state.stopReason).toBe('no_gallery');
    expect(again.buys).toEqual([]);
  });

  it('ignores a new list while it runs', async () => {
    const h = setup({ results: () => [listing('t1', 3_700)], maxSearches: 1 });
    h.sniper.start();
    h.sniper.setGallery({ budget: 1, spent: 0, cards: [] });
    await h.done();
    expect(h.gallery().budget).toBe(100_000);
  });
});

describe('clubMissReason', () => {
  it("says why a card did not go to the club, in the user's words", () => {
    expect(clubMissReason('club_not_bought')).toBe('Nova AI did not buy it on this page load');
    expect(clubMissReason('club_unsupported')).toBe('Nova AI cannot send cards to the club on this EA web app');
    expect(clubMissReason('move reported success: false (status 471)')).toBe('EA refused it (error 471): your club may already hold this card');
    expect(clubMissReason('act request timed out')).toBe('EA did not answer in time');
  });
});
