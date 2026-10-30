// Nova AI's Gallery mode (`engine/sniper.ts`, `runGallery`; rules in
// `engine/gallery.ts`): the trader's list, one card at a time. A card's
// version comes from a look-only search when the rating is not the player's
// base card's; it is bought under its market price for 30 seconds, then the
// cheapest listed (the search's max rising faster after each search that
// found none: never skipped for its price, only the budget stops it); a
// bought card goes to the club, to the transfer list and back on the market
// one step over what it cost, or at the lowest price that covers EA's tax
// when one step would not.
// The list's budget caps its buys, and its progress is saved after every
// change. A fut.gg lineup card is bought only as that exact card, priced on
// fut.gg when FUTBIN and Nova have nothing, and not bought at all when the
// club holds it already.
//
// A fake EA answers searches and the club/move/list calls; `sleep` advances
// a fake clock.

import { DEFAULT_BOT_MODE_SETTINGS, DEFAULT_BOT_SETTINGS, type BotSettings, type FilterCriteria, type GalleryCard, type GalleryState, type TrimmedAuction } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { Sniper, clubMissReason, fromClubMissReason, ownedMissReason, type SniperDeps } from '../../src/engine/sniper.js';
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
  moveResult?: () => ActionOutcome;
  listResult?: () => ActionOutcome;
  noClub?: boolean;
  /** What EA's club says it holds of the cards asked about. Omitted: no
   * club read on this page. */
  owned?: (resourceIds: number[]) => ActionOutcome;
  /** The account's collected-card catalogue (user_gallery_owned). Omitted: no
   * catalogue on this page. */
  ownedCatalogue?: number[];
  /** Searches before the test stops the bot. */
  maxSearches?: number;
  /** The club's copies of the cards asked about (`fromClub`). Omitted: the
   * page cannot read them. */
  fromClub?: (resourceIds: number[]) => ActionOutcome;
  /** EA's Clear Sold. Omitted: not available to the bot. */
  clearSold?: () => ActionOutcome;
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
    savedOwned: [] as number[],
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
      return opts.listResult?.() ?? { ok: true, signed: true, latencyMs: 5 };
    },
    move: async (tradeId) => {
      h.calls.push(`move ${tradeId}`);
      return opts.moveResult?.() ?? { ok: true, signed: true, latencyMs: 5 };
    },
    onAuctions: (cb) => {
      auctions.add(cb);
      return () => auctions.delete(cb);
    },
    onBuyable: () => () => undefined,
    onProbe: () => () => undefined,
    onShape: () => () => undefined,
  };
  if (opts.owned) {
    const owned = opts.owned;
    adapter.owned = async (ids) => {
      h.calls.push(`owned ${ids.join(',')}`);
      return owned(ids);
    };
  }
  if (opts.fromClub) {
    const fromClub = opts.fromClub;
    adapter.fromClub = async (ids) => {
      h.calls.push(`fromClub ${ids.join(',')}`);
      return fromClub(ids);
    };
  }
  if (opts.clearSold) {
    const clearSold = opts.clearSold;
    adapter.clearSold = async () => {
      h.calls.push('clearSold');
      return clearSold();
    };
  }
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
    ...(opts.ownedCatalogue ? { loadGalleryOwned: async () => opts.ownedCatalogue! } : {}),
    saveGalleryOwned: (ids) => void h.savedOwned.push(...ids),
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
  it("buys a card under its market price, sends it to the club, moves it and lists it at the lowest price that covers EA's tax", async () => {
    // The minimum profit never holds a Gallery buy back: each one is bought to collect.
    const h = setup({ settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 5_000 } }, results: () => [listing('t1', 3_700)] });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]!.filter).toEqual({ resourceId: 100, minRating: 85, maxRating: 85, maxPrice: 3_900 });
    expect(h.calls).toEqual(['buy t1', 'club t1', 'move t1', 'list t1']);
    // One step over its 3,700 (3,800) would bring back 3,610 after EA's 5% tax: 3,900 brings back 3,705.
    expect(h.lists).toEqual([['t1', 3_800, 3_900]]);
    expect(h.gallery()).toEqual({ budget: 100_000, spent: 3_700, cards: [card({ status: 'listed', price: 3_700, market: 4_000, listPrice: 3_900 })] });
    expect(h.trades).toEqual([{ tradeId: 't1', resourceId: 100, buyPrice: 3_700 }]);
    expect(h.sniper.state.stopReason).toBe('gallery_done');
    expect(h.log()).toContain('Sent {card} to your club');
    expect(h.log()).toContain("Gallery: the lowest price that covers EA's 5% tax on what it cost (3,700 coins)");
    // Its progress was saved after every step.
    expect(h.saved.at(-1)).toEqual(h.gallery());
  });

  it('looks only under the market price for 30 seconds, then buys the cheapest at the market price', async () => {
    const h = setup({ results: () => [listing('t1', 4_000)] });
    h.sniper.start();
    await h.done();
    const [buy] = h.buys;
    expect(buy![1]).toBe(4_000);
    expect(buy![2]).toBeGreaterThanOrEqual(START + 30 * SEC);
    expect(buy![2]).toBeLessThan(START + 60 * SEC);
    // Every search before that asked for less than the market price.
    for (const s of h.searches.slice(0, -1)) expect(s.filter.maxPrice).toBeLessThan(4_000);
    expect(h.searches.at(-1)!.filter.maxPrice).toBe(4_000);
    expect(h.log()).toContain('Gallery: none of {card} under its market price (4,000 coins) — buying the cheapest one listed');
  });

  it('raises the max faster after each search that found none, and buys the cheapest listed: never skipped for its price', async () => {
    const h = setup({ results: () => [listing('t2', 5_200), listing('t1', 5_000)] });
    h.sniper.start();
    await h.done();
    const market = h.searches.filter((s) => (s.filter.maxPrice ?? 0) >= 4_000).map((s) => s.filter.maxPrice);
    expect(market).toEqual([4_000, 4_100, 4_200, 4_400, 4_800, 5_600]);
    expect(h.buys.map(([id, price]) => [id, price])).toEqual([['t1', 5_000]]);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', price: 5_000, listPrice: 5_300 });
    expect(h.sniper.state.stopReason).toBe('gallery_done');
  });

  it('puts a card none of is listed at the end of the list, and buys the next one first', async () => {
    const other = card({ key: '200:85', playerId: 200, resourceId: 200, name: 'Florian Wirtz' });
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [card(), other] },
      // Nothing of Hugo Ekitiké, at any price; Florian Wirtz at 3,700.
      results: (_n, f) => (f.resourceId === 200 ? [listing('w1', 3_700, { resourceId: 200, assetId: 200 })] : []),
      market: (id) => (id === 200 ? 4_000 : null),
      maxSearches: 12,
    });
    h.sniper.start();
    await h.done();
    expect(h.buys.map(([id]) => id)).toEqual(['w1']);
    // Hugo Ekitiké is never listed: Nova buys Florian Wirtz first, moving
    // Ekitiké to the back each pass, and after GALLERY_MISS_CAP empty passes
    // leaves it out (`skipped`) rather than searching for it forever — which
    // is what used to pile empty searches up into an EA rate limit.
    expect(h.gallery().cards.map((c) => [c.name, c.status])).toEqual([
      ['Florian Wirtz', 'listed'],
      ['Hugo Ekitiké', 'skipped'],
    ]);
    expect(h.gallery().cards[1]!.misses).toBe(3);
    expect(h.gallery().cards[1]!.note).toContain('Not on the market after 3 tries');
    // It did try the others first (moved the card to the back) before giving up.
    expect(h.log()).toContain('Gallery: none listed at this rating right now for {card} — trying again after the other cards');
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
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', resourceId: 50_000_100, market: 10_000, listPrice: 10_000 });
  });

  it('buys only the version asked for: searched by its rarity, then that card alone, whatever else is listed', async () => {
    const signature = (id: string, buyNow: number) => listing(id, buyNow, { resourceId: 60_000_100 });
    // A cheaper normal 85 of the same player sneaks into the results.
    const normal = (id: string, buyNow: number) => listing(id, buyNow, { resourceId: 100 });
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [card({ key: '100:85:52', resourceId: undefined, rarity: 52, version: 'Signature' })] },
      results: (n) => (n === 1 ? [signature('s1', 7_000)] : [normal('n2', 3_000), signature('s2', 7_500)]),
      market: (id) => (id === 60_000_100 ? 8_000 : 4_000),
    });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]!.filter).toEqual({ resourceId: 100, minRating: 85, maxRating: 85, rarity: 52 });
    expect(h.searches[1]!.filter).toMatchObject({ rarity: 52, maxPrice: 7_900 });
    expect(h.prices).toContain(60_000_100);
    expect(h.buys.map(([id, price]) => [id, price])).toEqual([['s2', 7_500]]);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', resourceId: 60_000_100, market: 8_000, listPrice: 7_900 });
  });

  it('prices a card by the cheapest listing seen when FUTBIN and Nova have none', async () => {
    const h = setup({ market: () => null, results: (n) => (n === 1 ? [listing('t1', 3_000)] : [listing('t2', 2_900)]), gallery: { budget: 100_000, spent: 0, cards: [card()] } });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]!.filter.maxPrice).toBeUndefined();
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', market: 3_000, price: 2_900, listPrice: 3_100 });
  });

  it("buys a card at EA's lowest price straight at the market price: nothing lists under it", async () => {
    const h = setup({ market: () => 200, results: () => [listing('t1', 200)] });
    h.sniper.start();
    await h.done();
    expect(h.searches.map((s) => s.filter.maxPrice)).toEqual([200]);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', price: 200, listPrice: 250 });
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

  it('a card step EA rate-limits makes the bot back off: the next step waits it out, and the steps go at a hand-made pace', async () => {
    const clubAt: number[] = [];
    let limited = true;
    const h = setup({
      results: () => [listing('t1', 3_700)],
      clubResult: () => {
        clubAt.push(h.clock.t);
        if (!limited) return { ok: true, signed: true, latencyMs: 5 };
        limited = false;
        return { ok: false, signed: true, error: 'move to club did not report success: false (status 429)', latencyMs: 5 };
      },
    });
    h.sniper.start();
    await h.done();
    expect(h.calls).toEqual(['buy t1', 'club t1', 'club t1', 'move t1', 'list t1']);
    expect(h.log()).toContain('EA says too many requests (error 429): waiting 5 s before the next search');
    // 5 s of EA backoff, then the 3 s pause before the step again (the
    // pause alone was 1.5 s).
    expect(clubAt[1]! - clubAt[0]!).toBeGreaterThanOrEqual(8 * SEC);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', listPrice: 3_900 });
  });

  it('after a lost race, buys nothing more from that search: the next buy waits for the next search', async () => {
    let lost = false;
    const h = setup({
      results: () => [listing('t1', 3_700), listing('t2', 3_700)],
      buyResult: () => {
        if (lost) return { ok: true, signed: true, latencyMs: 5 };
        lost = true;
        return { ok: false, signed: true, error: 'bid reported success: false (status 403)', latencyMs: 5 };
      },
    });
    h.sniper.start();
    await h.done();
    // Not t2 a moment after t1 was lost (EA answered that one 429): t1 again,
    // from the next search, a search delay later.
    expect(h.buys.map(([id]) => id)).toEqual(['t1', 't1']);
    expect(h.buys[1]![2] - h.buys[0]![2]).toBeGreaterThanOrEqual(10 * SEC);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', price: 3_700 });
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

  it('stops when a card costs more than what is left of the budget, and says what it costs', async () => {
    const h = setup({
      gallery: { budget: 5_000, spent: 0, cards: [card(), card({ key: '200:85', playerId: 200, resourceId: 200, name: 'Florian Wirtz' })] },
      results: (_n, f) => [listing(`t${f.resourceId}`, f.resourceId === 100 ? 3_700 : 4_000, { resourceId: f.resourceId, assetId: f.resourceId })],
    });
    h.sniper.start();
    await h.done();
    expect(h.buys.map(([id]) => id)).toEqual(['t100']);
    // Its last search asked for no max, to see what it costs.
    expect(h.searches.at(-1)!.filter.maxPrice).toBeUndefined();
    expect(h.sniper.state.stopReason).toBe('gallery_budget');
    expect(h.gallery().cards[1]).toMatchObject({ status: 'todo', note: 'Cheapest listed: 4,000 coins, over the 1,300 coins left of your Gallery budget' });
    expect(h.log()).toContain('Gallery: the cheapest {card} is 4,000 coins, more than the 1,300 coins left of your Gallery budget');
  });

  it('ignores the max buy price: only the Gallery budget limits a buy', async () => {
    const h = setup({
      settings: { thresholds: { ...DEFAULT_BOT_SETTINGS.thresholds, minProfit: 0, maxBuyPrice: 3_000 } },
      results: () => [listing('t1', 3_700)],
    });
    h.sniper.start();
    await h.done();
    expect(h.buys.map(([id, price]) => [id, price])).toEqual([['t1', 3_700]]);
    expect(h.gallery().cards[0]!.status).toBe('listed');
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

describe('Gallery mode — fut.gg lineup cards', () => {
  // Shea Charles 80 TOTW, as fut.gg's lineup names it: the holographic copy.
  const HOLO = 67_000_100;
  const NORMAL = 50_000_100;
  const exact = (extra: Partial<GalleryCard> = {}): GalleryCard =>
    card({ key: `100:80#${HOLO}`, name: 'Shea Charles', rating: 80, resourceId: HOLO, exact: true, rarity: 3, version: 'Team of the Week Holographic', setIds: [54], guide: 4_000, ...extra });

  it('buys only that exact card, never another version at the same rating and rarity', async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact()] },
      results: () => [listing('normal', 3_000, { resourceId: NORMAL, rating: 80 }), listing('holo', 3_700, { resourceId: HOLO, rating: 80 })],
    });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]!.filter).toEqual({ resourceId: 100, minRating: 80, maxRating: 80, rarity: 3, maxPrice: 3_900 });
    expect(h.buys.map(([id]) => id)).toEqual(['holo']);
    expect(h.prices[0]).toBe(HOLO);
    expect(h.gallery().cards[0]).toMatchObject({ status: 'listed', price: 3_700 });
  });

  it("prices the card on fut.gg's price when FUTBIN and Nova have none", async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact({ guide: 5_000 })] },
      market: () => null,
      results: () => [listing('holo', 4_800, { resourceId: HOLO, rating: 80 })],
    });
    h.sniper.start();
    await h.done();
    expect(h.searches[0]!.filter.maxPrice).toBe(4_900);
    expect(h.buys.map(([id, price]) => [id, price])).toEqual([['holo', 4_800]]);
    expect(h.log()).toContain('Gallery: {card} — fut.gg price 5,000 coins; looking for one under it for 30 seconds first');
  });

  it('asks the club first, and buys none of the cards it holds already', async () => {
    const other = exact({ key: '200:79#200', name: 'Alex Iwobi', playerId: 200, resourceId: 200, rating: 79, rarity: undefined, version: undefined });
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact(), other] },
      owned: () => ({ ok: true, owned: [HOLO], signed: true, latencyMs: 5 }),
      results: (_n, f) => [listing(`t${f.resourceId}`, 700, { resourceId: f.resourceId, assetId: f.resourceId, rating: 79 })],
    });
    h.sniper.start();
    await h.done();
    expect(h.calls[0]).toBe(`owned ${HOLO},200`);
    expect(h.searches.every((s) => s.filter.resourceId === 200)).toBe(true);
    expect(h.gallery().cards.map((c) => c.status)).toEqual(['owned', 'listed']);
    expect(h.log()).toContain('Gallery: 1 card of your list is in your club already — it counts for its Set, so Nova will not buy it');
    expect(h.sniper.state.stopReason).toBe('gallery_done');
  });

  it('says so when the club holds none of the cards still to buy', async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact()] },
      owned: () => ({ ok: true, owned: [], signed: true, latencyMs: 5 }),
    });
    expect(await h.sniper.checkGalleryClub()).toBe(0);
    expect(h.log()).toContain('Gallery: checked your club: none of the 1 card still to buy is in it');
  });

  it("says EA's club search ignored the cards asked about, and buys every card", async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact()] },
      owned: () => ({ ok: false, error: 'owned_unfiltered: Club.search answered with players not asked about', signed: true, latencyMs: 5 }),
    });
    expect(await h.sniper.checkGalleryClub()).toBeNull();
    expect(h.log()).toContain("Gallery: could not check your club (EA's club search answered with other players than the ones asked about) — buying every card on the list");
  });

  it('buys every card when the club cannot be read', async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact()] },
      owned: () => ({ ok: false, error: 'owned_unsupported', signed: true, latencyMs: 5 }),
      results: () => [listing('holo', 3_700, { resourceId: HOLO, rating: 80 })],
    });
    h.sniper.start();
    await h.done();
    expect(h.buys.map(([id]) => id)).toEqual(['holo']);
    expect(h.log()).toContain('Gallery: could not check your club (this EA web app has no club search Nova AI knows) — buying every card on the list');
  });

  it('checks the club for the page while stopped, and a run right after does not ask again', async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact()] },
      owned: () => ({ ok: true, owned: [HOLO], signed: true, latencyMs: 5 }),
    });
    expect(await h.sniper.checkGalleryClub()).toBe(1);
    expect(h.saved.at(-1)!.cards[0]!.status).toBe('owned');
    h.sniper.start();
    expect(h.sniper.state.stopReason).toBe('no_gallery');
    expect(h.calls).toEqual([`owned ${HOLO}`]);
  });

  it('never buys a card in the account catalogue: it was collected before (and since sold) and counts still', async () => {
    // HOLO is in the account's catalogue — put through the club before, then
    // listed again and sold, so it is not in the club now. It must still count
    // for its Set, so Nova never buys it a second time.
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact()] },
      ownedCatalogue: [HOLO],
      results: () => [listing('holo', 3_700, { resourceId: HOLO, rating: 80 })],
    });
    h.sniper.start();
    await h.done();
    expect(h.buys).toEqual([]);
    expect(h.gallery().cards[0]!.status).toBe('owned');
    expect(h.sniper.state.stopReason).toBe('gallery_done');
  });

  it('records a clubbed card in the account catalogue, so a later run never buys it again', async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 0, cards: [exact()] },
      results: () => [listing('holo', 3_700, { resourceId: HOLO, rating: 80 })],
    });
    h.sniper.start();
    await h.done();
    expect(h.calls).toContain('club holo');
    expect(h.savedOwned).toContain(HOLO);
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

describe('Gallery mode — cards EA would not move from the club (a full transfer list)', () => {
  const ok = (): ActionOutcome => ({ ok: true, signed: true, latencyMs: 5 });
  const refused = (): ActionOutcome => ({ ok: false, signed: true, error: 'move reported success: false (status 473)', latencyMs: 5 });
  const inClub = (tradeId = 'club:555'): ActionOutcome => ({ ok: true, signed: true, clubCards: [{ resourceId: 100, tradeId }], latencyMs: 5 });

  it('clears the sold cards once to make room when EA refuses the move, then tries again', async () => {
    let moves = 0;
    const h = setup({ results: () => [listing('t1', 1_300)], moveResult: () => (++moves === 1 ? refused() : ok()), clearSold: ok });
    h.sniper.start();
    await h.done();
    expect(h.calls).toEqual(['buy t1', 'club t1', 'move t1', 'clearSold', 'move t1', 'list t1']);
    expect(h.gallery().cards[0]!.status).toBe('listed');
    expect(h.log()).toContain('{card} not moved to the transfer list (EA refused the move (error 473): your transfer list may be full): cleared the sold cards to make room, trying again');
  });

  it('leaves a card EA keeps refusing in the club, saying what to do, and finds it there again at the next Start', async () => {
    const h = setup({ results: () => [listing('t1', 1_300)], moveResult: refused, clearSold: ok, fromClub: () => inClub() });
    h.sniper.start();
    await h.done();
    // Three tries of the move (one after the sold cards were cleared), then it stays in the club.
    expect(h.calls).toEqual(['buy t1', 'club t1', 'move t1', 'clearSold', 'move t1', 'move t1', 'move t1']);
    expect(h.gallery().cards[0]).toEqual(
      card({
        status: 'club',
        price: 1_300,
        market: 4_000,
        note: 'Not listed: EA refused the move (error 473): your transfer list may be full. In your club: make room on your transfer list (Clear sold), then Relist from club on the Gallery tab, or Start again',
      }),
    );
    expect(h.sniper.state.stopReason).toBe('gallery_done');
    expect(h.saved.at(-1)).toEqual(h.gallery());

    // Room made (the trader cleared the list): the next Start asks the club for the
    // card, and takes the copy it holds to the market, from the club's own copy.
    const again = setup({ gallery: h.gallery(), moveResult: ok, fromClub: () => inClub() });
    again.sniper.start();
    await again.done();
    expect(again.calls).toEqual(['fromClub 100', 'move club:555', 'list club:555']);
    expect(again.lists).toEqual([['club:555', 1_300, 1_400]]);
    expect(again.gallery().cards[0]).toEqual(card({ status: 'listed', price: 1_300, market: 4_000, listPrice: 1_400 }));
    expect(again.log()).toContain('Gallery: 1 card waiting in your club found there, on its way to the market');
    expect(again.sniper.state.stopReason).toBe('gallery_done');
  });

  it('counts the cards waiting in the club as work for a Start, and says when the club no longer holds one or cannot be read', async () => {
    const stuck = { budget: 100_000, spent: 1_300, cards: [card({ status: 'club', price: 1_300 })] };
    const gone = setup({ gallery: stuck, fromClub: () => ({ ok: true, signed: true, clubCards: [], latencyMs: 5 }) });
    gone.sniper.start();
    await gone.done();
    expect(gone.calls).toEqual(['fromClub 100']);
    expect(gone.gallery().cards[0]!.status).toBe('club');
    expect(gone.log()).toContain('Gallery: none of the 1 card waiting in your club is in it any more: if you listed it yourself, press Listed it myself');
    expect(gone.sniper.state.stopReason).toBe('gallery_done');

    const unread = setup({ gallery: stuck, fromClub: () => ({ ok: false, signed: true, error: 'from_club_too_soon', latencyMs: 5 }) });
    unread.sniper.start();
    await unread.done();
    expect(unread.log()).toContain('Gallery: 1 card waiting in your club could not be found there (your club was read a moment ago — try again in a few seconds): it stays in your club');
    expect(unread.gallery().cards[0]!.status).toBe('club');

    // Without the club read (an older page), a card with no trade left is nothing to start on.
    const old = setup({ gallery: stuck });
    old.sniper.start();
    expect(old.sniper.state.stopReason).toBe('no_gallery');
  });

  it('relists the cards waiting in the club on the Gallery tab without a Start (Relist from club), one at a time', async () => {
    const h = setup({
      gallery: {
        budget: 100_000,
        spent: 2_600,
        cards: [card({ status: 'club', price: 1_300, note: 'Not listed: EA did not move it' }), card({ key: '100:85#2', status: 'club', price: 1_300 })],
      },
      fromClub: () => ({ ok: true, signed: true, clubCards: [{ resourceId: 100, tradeId: 'club:1' }, { resourceId: 100, tradeId: 'club:2' }], latencyMs: 5 }),
    });
    const progress: [number, number][] = [];
    const t0 = h.clock.t;
    const result = await h.sniper.relistStuck((done, total) => progress.push([done, total]));
    expect(result).toEqual({ ok: true, message: 'Relisted 2 of 2 cards from your club' });
    expect(h.calls).toEqual(['fromClub 100', 'move club:1', 'list club:1', 'move club:2', 'list club:2']);
    expect(progress).toEqual([[1, 2], [2, 2]]);
    // A pause before each step, as the bot paces them (3 s at random() = 0).
    expect(h.clock.t - t0).toBe(4 * 3 * SEC);
    expect(h.gallery().cards.map((c) => [c.status, c.listPrice, c.note])).toEqual([['listed', 1_400, undefined], ['listed', 1_400, undefined]]);
    expect(h.sniper.isRunning()).toBe(false);
    expect(await h.sniper.relistStuck()).toEqual({ ok: true, message: 'No card is waiting in your club' });
  });

  it('says when a relist from the club cannot run, or lists only some', async () => {
    const stuck = { budget: 100_000, spent: 1_300, cards: [card({ status: 'club', price: 1_300 })] };
    const old = setup({ gallery: stuck });
    expect(await old.sniper.relistStuck()).toEqual({
      ok: false,
      message: '1 card waiting in your club could not be found there (Nova AI cannot move cards from your club on this EA web app): it stays in your club',
    });
    const failing = setup({ gallery: stuck, fromClub: () => inClub(), listResult: () => ({ ok: false, signed: true, error: 'list reported success: false', latencyMs: 5 }) });
    expect(await failing.sniper.relistStuck()).toEqual({ ok: false, message: 'Relisted 0 of 1 card from your club; 1 not listed: see the Gallery tab' });
    expect(failing.calls).toEqual(['fromClub 100', 'move club:555', 'list club:555', 'list club:555', 'list club:555']);
    expect(failing.gallery().cards[0]!.note).toBe('Not listed: list reported success: false. It is in your transfer list');
    // Not while the bot runs: a Start does it on its own.
    const running = setup({ gallery: stuck, fromClub: () => inClub(), results: () => [] });
    running.sniper.start();
    expect(await running.sniper.relistStuck()).toEqual({ ok: false, message: 'Nova AI is running: it relists these on its own' });
    running.sniper.stop('manual');
    await running.done();
  });

  it('names why the club could not be read', () => {
    expect(fromClubMissReason('from_club_unsupported')).toBe('Nova AI cannot move cards from your club on this EA web app');
    expect(fromClubMissReason('from_club_too_soon')).toBe('your club was read a moment ago — try again in a few seconds');
    expect(fromClubMissReason('owned_unsupported')).toBe(ownedMissReason('owned_unsupported'));
  });
});

describe('Gallery mode — cards bought on an earlier run, and Sets done', () => {
  it('finishes a card whose way to the market did not finish, from where it was', async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 1_300, cards: [card({ status: 'club', price: 1_300, tradeId: 't7' }), card({ key: '200:85', playerId: 200, resourceId: 200, status: 'listed' })] },
    });
    h.sniper.start();
    await h.done();
    // In the club already: to the transfer list, then listed a step over its price.
    expect(h.calls).toEqual(['move t7', 'list t7']);
    expect(h.lists).toEqual([['t7', 1_300, 1_400]]);
    expect(h.gallery().cards[0]).toEqual(card({ status: 'listed', price: 1_300, listPrice: 1_400 }));
    // Under about 2,000 coins one step over already covers EA's tax.
    expect(h.log()).toContain('Gallery: one step over what it cost (1,300 coins)');
  });

  it('says to finish it by hand when the page reloaded since its buy, and does not try again', async () => {
    const h = setup({
      gallery: { budget: 100_000, spent: 1_300, cards: [card({ status: 'bought', price: 1_300, tradeId: 't7' })] },
      clubResult: () => ({ ok: false, signed: true, error: 'club_not_bought', latencyMs: 5 }),
    });
    h.sniper.start();
    await h.done();
    expect(h.calls).toEqual(['club t7']);
    expect(h.gallery().cards[0]).toEqual(
      card({ status: 'bought', price: 1_300, note: 'Bought before the page reloaded, so Nova AI can no longer move it: send it to your club and list it by hand' }),
    );
    const again = setup({ gallery: h.saved.at(-1)! });
    again.sniper.start();
    expect(again.calls).toEqual([]);
  });

  it('marks a fut.gg Set completed once all its cards are collected, and says to finish it in the game', async () => {
    const set = { id: 90, name: 'Malaga CF', path: 'laliga/malaga-cf', grade: 'S' as const, threshold: 900, score: 908, tokens: 28, cost: 3_700 };
    const h = setup({
      gallery: { budget: 100_000, spent: 0, sets: [set], cards: [card({ exact: true, setIds: [90] }), card({ key: '200:85#200', playerId: 200, resourceId: 200, exact: true, setIds: [90], status: 'owned' })] },
      results: () => [listing('t1', 3_700)],
    });
    h.sniper.start();
    await h.done();
    expect(h.gallery().completed).toEqual([90]);
    expect(h.log()).toContain('Gallery: Malaga CF is complete: every card is collected. Finish it in the game: Gallery, Malaga CF, Autocomplete, then Confirm Changes');
  });

  it('marks a Set completed when its last card lands in the club, even if listing it fails', async () => {
    const set = { id: 90, name: 'Malaga CF', path: 'laliga/malaga-cf', grade: 'S' as const, threshold: 900, score: 908, tokens: 28, cost: 3_700 };
    const h = setup({
      gallery: { budget: 100_000, spent: 0, sets: [set], cards: [card({ exact: true, setIds: [90] }), card({ key: '200:85#200', playerId: 200, resourceId: 200, exact: true, setIds: [90], status: 'owned' })] },
      results: () => [listing('t1', 3_700)],
      // EA takes the card into the club but refuses every listing attempt.
      listResult: () => ({ ok: false, signed: true, error: 'EA refused the listing', latencyMs: 5 }),
    });
    h.sniper.start();
    await h.done();
    // The card never reached `listed`, but it is in the club, so the Set is done.
    expect(h.gallery().cards[0]!.status).toBe('club');
    expect(h.gallery().completed).toEqual([90]);
    expect(h.log()).toContain('Gallery: Malaga CF is complete: every card is collected. Finish it in the game: Gallery, Malaga CF, Autocomplete, then Confirm Changes');
  });

  it('reads the club for the page, and says why when it cannot', async () => {
    const h = setup({ owned: (ids) => ({ ok: true, owned: ids.slice(0, 1), signed: true, latencyMs: 5 }) });
    expect(await h.sniper.readClub([7, 8])).toEqual({ ok: true, owned: [7] });
    expect(await h.sniper.readClub([])).toEqual({ ok: true, owned: [] });
    const off = setup({ owned: () => ({ ok: false, error: 'owned_too_soon', signed: true, latencyMs: 5 }) });
    expect(await off.sniper.readClub([7])).toEqual({ ok: false, why: 'it was checked a moment ago' });
    expect(await setup().sniper.readClub([7])).toEqual({ ok: false, why: 'this EA web app has no club search Nova AI knows' });
  });
});

describe('ownedMissReason', () => {
  it("says why the club could not be read, in the user's words", () => {
    expect(ownedMissReason('owned_unsupported')).toBe('this EA web app has no club search Nova AI knows');
    expect(ownedMissReason('owned_too_soon')).toBe('it was checked a moment ago');
    expect(ownedMissReason(undefined)).toBe('EA did not answer in time');
    expect(ownedMissReason('Club.search reported success: false (status 512)')).toBe('EA refused it (error 512)');
    expect(ownedMissReason('Club.search answered without an item list')).toBe('EA did not answer as expected');
  });
});
