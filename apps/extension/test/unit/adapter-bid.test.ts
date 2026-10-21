// main/adapter.ts's acts for Nova AI's Bid mode (automation builds): a bid
// through the web app's own bid call, only at exactly the next valid bid on
// an auction the adapter saw in one of EA's own answers (and under its
// buy-now price, on the card content names); a watch list read through the
// web app's own service, signed, that refreshes what the adapter knows; and
// a move to the transfer list only of a card the adapter itself won on this
// page load. A page without the Bid mode calls answers `bidding_unsupported`
// (Bid mode then refuses to run) and still snipes.
//
// adapter.ts wires itself up at import time and keeps module state (the gap
// between watch list reads), so this file imports its own copy, once.

import { adapterActionResultMessageSchema } from '@sl/shared';
import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_ATTRIBUTE, canonicalActMessage, createActSigner, generateNonce, type ActSigner } from '../../src/lib/act-auth.js';
import { createObservableShape } from '../../src/main/shape-observable.js';
import { createPromiseShape } from '../../src/main/shape-promise.js';
import { itemEntity, observable, promiseServices, utasAuction, type ListingSpec } from '../fixtures/ea-shapes.js';

const NONCE = generateNonce();
let signer: ActSigner;

interface Posted {
  channel: string;
  kind: string;
  data: Record<string, unknown>;
  mac?: string;
}
let posted: Posted[] = [];
let requestSeq = 0;

function install(services: unknown): void {
  (window as unknown as { services: unknown }).services = services;
}

function deliver(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message, source: window }));
}

async function act(data: Record<string, unknown>): Promise<Posted> {
  const requestId = `req-${++requestSeq}`;
  const full = { ...data, requestId };
  const mac = await signer.sign(canonicalActMessage('act_request', full));
  deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: full, mac });
  await vi.waitFor(() => expect(posted.find((m) => m.kind === 'action_result' && m.data.requestId === requestId)).toBeDefined(), { timeout: 3000 });
  return posted.find((m) => m.kind === 'action_result' && m.data.requestId === requestId)!;
}

/** Sends a request and waits long enough for an answer that never comes. */
async function actIgnored(data: Record<string, unknown>): Promise<boolean> {
  const requestId = `req-${++requestSeq}`;
  const full = { ...data, requestId };
  deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: full, mac: await signer.sign(canonicalActMessage('act_request', full)) });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
  return posted.every((m) => m.kind !== 'action_result' || m.data.requestId !== requestId);
}

/** The observable shape with Bid mode's calls: search, bid, the watch list
 * and the move, each answering through an observable. */
function biddingServices(found: ReturnType<typeof itemEntity>[] = [], watched: ReturnType<typeof itemEntity>[] = []) {
  const searchTransferMarket = vi.fn((_criteria: Record<string, unknown>, _page: number): unknown => observable({ success: true, data: { items: found } }));
  const bid = vi.fn((_item: unknown, _price: number): unknown => observable({ success: true, data: {} }));
  const requestWatchedItems = vi.fn((): unknown => observable({ success: true, data: { items: watched } }));
  const move = vi.fn((_item: unknown, _pile: unknown): unknown => observable({ success: true, data: {} }));
  const list = vi.fn((_item: unknown, _s: number, _b: number, _d: number): unknown => observable({ success: true, data: {} }));
  return {
    services: { Item: { searchTransferMarket, bid, requestWatchedItems, move, list, clearTransferMarketCache: vi.fn() } },
    searchTransferMarket,
    bid,
    requestWatchedItems,
    move,
    list,
  };
}

const auctionSpec = (tradeId: number, extra: Partial<ListingSpec> = {}): ListingSpec => ({
  tradeId,
  buyNowPrice: 20_000,
  startingBid: 10_000,
  currentBid: 0,
  expires: 180,
  resourceId: 7,
  ...extra,
});

beforeAll(async () => {
  signer = createActSigner(NONCE)!;
  install(biddingServices().services);
  window.fetch = vi.fn(async () => new Response('{}')) as unknown as typeof window.fetch;
  window.addEventListener('message', (e) => {
    const m = e.data as Posted | null;
    if (m && m.channel === ADAPTER_CHANNEL) posted.push(m);
  });
  (window as unknown as { ItemPile: unknown }).ItemPile = { TRANSFER: 5, CLUB: 7 };
  document.documentElement.setAttribute(HANDOFF_ATTRIBUTE, NONCE);
  await import('../../src/main/adapter.js');
});

beforeEach(() => {
  posted = [];
});

describe('search by bid (Bid mode)', () => {
  it("passes the max bid as EA's own maxBid criterion, outside the filter", async () => {
    const svc = biddingServices();
    install(svc.services);
    expect((await act({ action: 'search', filter: { resourceId: 7 }, maxBid: 12_500 })).data.ok).toBe(true);
    expect(svc.searchTransferMarket.mock.calls[0]![0]).toMatchObject({ maskedDefId: 7, maxBid: 12_500 });
    expect(svc.searchTransferMarket.mock.calls[0]![0]).not.toHaveProperty('maxBuy');
  });

  it('drops a search whose max bid is not a bid EA takes', async () => {
    install(biddingServices().services);
    expect(await actIgnored({ action: 'search', filter: {}, maxBid: 100 })).toBe(true);
  });
});

describe('bid', () => {
  async function seen(spec: ListingSpec) {
    const entity = itemEntity(spec);
    const svc = biddingServices([entity]);
    install(svc.services);
    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(true);
    return { svc, entity };
  }

  it('bids the next valid bid on the very entity the search returned, signed, and refuses the same bid twice', async () => {
    const { svc, entity } = await seen(auctionSpec(601));
    const res = await act({ action: 'bid', tradeId: '601', price: 10_000, resourceId: 7 });
    expect(res.data).toMatchObject({ action: 'bid', ok: true });
    expect(await signer.verify(canonicalActMessage('action_result', res.data), res.mac!)).toBe(true);
    expect(svc.bid).toHaveBeenCalledTimes(1);
    expect(svc.bid.mock.calls[0]![0]).toBe(entity);
    expect(svc.bid.mock.calls[0]![1]).toBe(10_000);
    // The bid is the auction's current one now: the next valid bid is a step up.
    expect((await act({ action: 'bid', tradeId: '601', price: 10_000 })).data).toMatchObject({ ok: false, error: 'price_mismatch' });
    expect((await act({ action: 'bid', tradeId: '601', price: 10_250 })).data.ok).toBe(true);
  });

  it('refuses any other amount, a bid at the buy-now price, another card, an auction it never saw', async () => {
    const { svc } = await seen(auctionSpec(602, { currentBid: 19_750 }));
    expect((await act({ action: 'bid', tradeId: '602', price: 19_900 })).data).toMatchObject({ ok: false, error: 'price_mismatch' });
    // 19,750 + 250 = 20,000: the buy-now price, which is a buy, not a bid.
    expect((await act({ action: 'bid', tradeId: '602', price: 20_000 })).data).toMatchObject({ ok: false, error: 'price_mismatch' });
    expect((await act({ action: 'bid', tradeId: '602', price: 20_000, resourceId: 8 })).data).toMatchObject({ ok: false, error: 'resource_mismatch' });
    expect((await act({ action: 'bid', tradeId: '999', price: 10_000 })).data).toMatchObject({ ok: false, error: 'listing_unknown' });
    expect(svc.bid).not.toHaveBeenCalled();
  });

  it('drops a request with an amount EA never takes, unanswered', async () => {
    await seen(auctionSpec(603));
    expect(await actIgnored({ action: 'bid', tradeId: '603', price: 100 })).toBe(true);
    expect(await actIgnored({ action: 'bid', tradeId: '603', price: 10_000, resourceId: -1 })).toBe(true);
  });

  it("says bidding_unsupported on a page without Bid mode's calls, and still searches", async () => {
    const svc = biddingServices([itemEntity(auctionSpec(604))]);
    delete (svc.services.Item as Record<string, unknown>).requestWatchedItems;
    install(svc.services);
    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(true);
    expect((await act({ action: 'bid', tradeId: '604', price: 10_000 })).data).toMatchObject({ ok: false, error: 'bidding_unsupported' });
    expect((await act({ action: 'watchlist' })).data).toMatchObject({ ok: false, error: 'bidding_unsupported' });
    expect(svc.bid).not.toHaveBeenCalled();
  });

  it("reports EA refusing the bid in EA's words, for the bot's plain reason", async () => {
    const { svc } = await seen(auctionSpec(605));
    svc.bid.mockReturnValueOnce(observable({ success: false, status: 461 }));
    const res = await act({ action: 'bid', tradeId: '605', price: 10_000 });
    expect(res.data).toMatchObject({ ok: false });
    expect(String(res.data.error)).toMatch(/success: false \(status 461\)/);
  });
});

describe('the watch list, and what was won', () => {
  // One read for the whole file: the adapter refuses another within 5 s.
  it('reads it signed, refreshes the auctions it holds, and lets only its own wins be moved and listed', async () => {
    // Bid on 701 first, so the adapter knows it as its own bid.
    const svc = biddingServices([itemEntity(auctionSpec(701))]);
    install(svc.services);
    await act({ action: 'search', filter: {} });
    expect((await act({ action: 'bid', tradeId: '701', price: 10_000 })).data.ok).toBe(true);

    const won = itemEntity(auctionSpec(701, { currentBid: 10_000, expires: -1, tradeState: 'closed', bidState: 'highest', itemId: 9701 }));
    const notOurs = itemEntity(auctionSpec(702, { currentBid: 11_000, expires: -1, tradeState: 'closed', bidState: 'highest', itemId: 9702 }));
    const outbid = itemEntity(auctionSpec(703, { currentBid: 12_000, expires: 40, bidState: 'outbid', itemId: 9703 }));
    svc.requestWatchedItems.mockReturnValueOnce(observable({ success: true, data: { items: [won, notOurs, outbid] } }));
    const res = await act({ action: 'watchlist' });
    expect(res.data).toMatchObject({ action: 'watchlist', ok: true });
    expect(await signer.verify(canonicalActMessage('action_result', res.data), res.mac!)).toBe(true);
    // What content's schema takes, field by field.
    expect(adapterActionResultMessageSchema.safeParse({ channel: ADAPTER_CHANNEL, kind: 'action_result', data: res.data, mac: res.mac }).success).toBe(true);
    expect(res.data.watched).toEqual([
      expect.objectContaining({ tradeId: '701', itemId: '9701', tradeState: 'closed', bidState: 'highest', currentBid: 10_000 }),
      expect.objectContaining({ tradeId: '702', tradeState: 'closed', bidState: 'highest' }),
      expect.objectContaining({ tradeId: '703', tradeState: 'active', bidState: 'outbid', currentBid: 12_000, expires: 40 }),
    ]);

    // Won on its own bid: moved to the transfer list (the web app's own
    // pile id), then listed.
    expect((await act({ action: 'move', tradeId: '701' })).data.ok).toBe(true);
    expect(svc.move.mock.calls[0]).toEqual([won, 5]);
    expect((await act({ action: 'list', tradeId: '701', startPrice: 14_750, buyNowPrice: 15_000 })).data.ok).toBe(true);
    expect(svc.list.mock.calls[0]![0]).toBe(won);
    // Closed on the trader's bid, but not one this adapter placed: untouched.
    expect((await act({ action: 'move', tradeId: '702' })).data).toMatchObject({ ok: false, error: 'move_not_bought' });
    expect((await act({ action: 'list', tradeId: '702', startPrice: 14_750, buyNowPrice: 15_000 })).data).toMatchObject({ ok: false, error: 'list_not_bought' });
    expect(svc.move).toHaveBeenCalledTimes(1);

    // The read refreshed the outbid auction: the re-bid is checked against
    // it and goes in on the watch list's own entity.
    expect((await act({ action: 'bid', tradeId: '703', price: 12_000 })).data).toMatchObject({ ok: false, error: 'price_mismatch' });
    expect((await act({ action: 'bid', tradeId: '703', price: 12_250 })).data.ok).toBe(true);
    expect(svc.bid.mock.calls.at(-1)).toEqual([outbid, 12_250]);
    // An ended auction takes no bid.
    expect((await act({ action: 'bid', tradeId: '702', price: 11_250 })).data).toMatchObject({ ok: false, error: 'listing_unknown' });

    // Another read straight away is refused: each is a request EA sees.
    expect((await act({ action: 'watchlist' })).data).toMatchObject({ ok: false, error: 'watchlist_too_soon' });
    expect(svc.requestWatchedItems).toHaveBeenCalledTimes(1);
  });

  it('says the promise shape has no move call', async () => {
    install(promiseServices().services);
    expect((await act({ action: 'move', tradeId: '701' })).data).toMatchObject({ ok: false, error: 'move_unsupported' });
  });
});

describe("Gallery mode's club call", () => {
  it("sends only a card it bought itself to the club (the web app's own club pile), and may then move and list it", async () => {
    const entity = itemEntity(auctionSpec(901, { buyNowPrice: 3_700 }));
    const svc = biddingServices([entity]);
    install(svc.services);
    await act({ action: 'search', filter: {} });
    expect((await act({ action: 'buy', tradeId: '901', price: 3_700 })).data.ok).toBe(true);
    const res = await act({ action: 'club', tradeId: '901' });
    expect(res.data).toMatchObject({ action: 'club', ok: true });
    expect(await signer.verify(canonicalActMessage('action_result', res.data), res.mac!)).toBe(true);
    expect(adapterActionResultMessageSchema.safeParse({ channel: ADAPTER_CHANNEL, kind: 'action_result', data: res.data, mac: res.mac }).success).toBe(true);
    expect(svc.move.mock.calls[0]).toEqual([entity, 7]);
    // Still its own card: to the transfer list, then listed.
    expect((await act({ action: 'move', tradeId: '901' })).data.ok).toBe(true);
    expect(svc.move.mock.calls[1]).toEqual([entity, 5]);
    expect((await act({ action: 'list', tradeId: '901', startPrice: 3_800, buyNowPrice: 3_900 })).data.ok).toBe(true);
    // Never a card it did not buy.
    expect((await act({ action: 'club', tradeId: '902' })).data).toMatchObject({ ok: false, error: 'club_not_bought' });
    expect(svc.move).toHaveBeenCalledTimes(2);
  });

  it('reports EA refusing the move (a card the club holds already)', async () => {
    const entity = itemEntity(auctionSpec(903, { buyNowPrice: 3_700 }));
    const svc = biddingServices([entity]);
    install(svc.services);
    await act({ action: 'search', filter: {} });
    expect((await act({ action: 'buy', tradeId: '903', price: 3_700 })).data.ok).toBe(true);
    svc.move.mockReturnValueOnce(observable({ success: false, status: 471 }));
    const res = await act({ action: 'club', tradeId: '903' });
    expect(res.data).toMatchObject({ action: 'club', ok: false });
    expect(String(res.data.error)).toMatch(/success: false/);
  });

  it('says the promise shape has no club call', async () => {
    install(promiseServices().services);
    expect((await act({ action: 'club', tradeId: '901' })).data).toMatchObject({ ok: false, error: 'club_unsupported' });
  });
});

describe("Gallery mode's club read", () => {
  // The web app's own search criteria class, as its Player Picks screen uses it.
  class Criteria {
    type = '';
    defId: number[] = [];
  }
  const clubItem = (definitionId: number, loan = false) => ({ definitionId, isLimitedUse: () => loan });

  it('says which of the cards asked about the club holds (loans and other versions left out)', async () => {
    const shape = createObservableShape(1_000);
    (window as unknown as { UTSearchCriteriaDTO?: unknown }).UTSearchCriteriaDTO = Criteria;
    try {
      // 50_574_960 is another version of player 243312 (EA adds multiples of 2^24).
      const search = vi.fn((_c: Criteria): unknown => observable({ success: true, response: { items: [clubItem(243312), clubItem(5, true), clubItem(50_574_960)] } }));
      const owned = await shape.bidding!.clubOwned!({ Club: { search } } as never, [243312, 5, 6]);
      expect(owned).toEqual([243312]);
      expect(search.mock.calls[0]![0]).toBeInstanceOf(Criteria);
      expect(search.mock.calls[0]![0].defId).toEqual([243312, 5, 6]);
      // `type` is set first, as the web app's Player Picks does: EA ignores a
      // criteria with no `type` and answers with the whole club, which reads
      // as "could not check". No window.SearchType here, so the fallback.
      expect(search.mock.calls[0]![0].type).toBe('player');
      // A player not asked about: the search ignored the card filter, and
      // its answer cannot say "none owned".
      const unfiltered = vi.fn((): unknown => observable({ success: true, response: { items: [clubItem(77)] } }));
      await expect(shape.bidding!.clubOwned!({ Club: { search: unfiltered } } as never, [243312])).rejects.toThrow(/^owned_unfiltered/);
      // Nothing it can read is never "none owned".
      const noList = vi.fn((): unknown => observable({ success: true, response: {} }));
      await expect(shape.bidding!.clubOwned!({ Club: { search: noList } } as never, [1])).rejects.toThrow(/without an item list/);
      const refused = vi.fn((): unknown => observable({ success: false, status: 500 }));
      await expect(shape.bidding!.clubOwned!({ Club: { search: refused } } as never, [1])).rejects.toThrow(/success: false/);
      await expect(shape.bidding!.clubOwned!({ Item: {} } as never, [1])).rejects.toThrow(/Club\.search is not a function/);
    } finally {
      delete (window as unknown as { UTSearchCriteriaDTO?: unknown }).UTSearchCriteriaDTO;
    }
  });

  it('says the promise shape has no club read, and drops a malformed request', async () => {
    install(promiseServices().services);
    expect((await act({ action: 'owned', resourceIds: [1] })).data).toMatchObject({ ok: false, error: 'owned_unsupported' });
    install(biddingServices().services);
    expect(await actIgnored({ action: 'owned', resourceIds: [] })).toBe(true);
    expect(await actIgnored({ action: 'owned', resourceIds: [0] })).toBe(true);
    expect(await actIgnored({ action: 'owned', resourceIds: Array.from({ length: 101 }, (_, i) => i + 1) })).toBe(true);
  });

  it('answers signed, and refuses a second read within a few seconds', async () => {
    const svc = biddingServices();
    const search = vi.fn((): unknown => observable({ success: true, response: { items: [clubItem(243312)] } }));
    install({ ...svc.services, Club: { search } });
    (window as unknown as { UTSearchCriteriaDTO?: unknown }).UTSearchCriteriaDTO = Criteria;
    try {
      const res = await act({ action: 'owned', resourceIds: [243312, 6] });
      expect(res.data).toMatchObject({ action: 'owned', ok: true, owned: [243312] });
      expect(await signer.verify(canonicalActMessage('action_result', res.data), res.mac!)).toBe(true);
      expect(adapterActionResultMessageSchema.safeParse({ channel: ADAPTER_CHANNEL, kind: 'action_result', data: res.data, mac: res.mac }).success).toBe(true);
      expect((await act({ action: 'owned', resourceIds: [6] })).data).toMatchObject({ ok: false, error: 'owned_too_soon' });
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { UTSearchCriteriaDTO?: unknown }).UTSearchCriteriaDTO;
    }
  });
});

describe("the shapes' Bid mode calls (ASSUMED SHAPE)", () => {
  it('promise shape: bids through Transfer.repository.bid and reads Item.repository.watchlist', async () => {
    const shape = createPromiseShape(1_000);
    const bid = vi.fn(async () => ({ success: true }));
    const watchlist = vi.fn(async () => ({ auctionInfo: [utasAuction({ tradeId: 801, buyNowPrice: 20_000 })] }));
    const services = { Item: { repository: { search: vi.fn(), watchlist } }, Transfer: { repository: { buyNow: vi.fn(), bid } } };
    expect(shape.bidding!.detect(services)).toBeNull();
    await shape.bidding!.bid(services, { tradeId: '801', amount: 10_000, entity: undefined });
    expect(bid).toHaveBeenCalledWith('801', 10_000);
    expect((await shape.bidding!.readWatchlist(services)).entries).toHaveLength(1);
    expect(shape.bidding!.moveToTransferList).toBeUndefined();
    bid.mockResolvedValueOnce({ success: false });
    await expect(shape.bidding!.bid(services, { tradeId: '801', amount: 10_250, entity: undefined })).rejects.toThrow(/success: false/);
    expect(shape.bidding!.detect({ Item: { repository: {} }, Transfer: { repository: { bid } } })).toMatch(/watchlist is not a function/);
  });

  it('observable shape: needs requestWatchedItems as well as bid, and the web app’s ItemPile to move', async () => {
    const shape = createObservableShape(1_000);
    const svc = biddingServices();
    expect(shape.bidding!.detect(svc.services)).toBeNull();
    expect(shape.bidding!.detect({ Item: { bid: vi.fn() } })).toMatch(/requestWatchedItems is not a function/);
    const pile = (window as unknown as { ItemPile: unknown }).ItemPile;
    (window as unknown as { ItemPile: unknown }).ItemPile = undefined;
    try {
      await expect(shape.bidding!.moveToTransferList!(svc.services, {})).rejects.toThrow(/ItemPile\.TRANSFER is not available/);
    } finally {
      (window as unknown as { ItemPile: unknown }).ItemPile = pile;
    }
    svc.requestWatchedItems.mockReturnValueOnce(observable({ success: true, data: {} }));
    await expect(shape.bidding!.readWatchlist(svc.services)).rejects.toThrow(/requestWatchedItems response has no/);
  });

  // Live: requestWatchedItems answered from the web app's cache, the same
  // time left and bids read after read, while the auctions were outbid.
  it('observable shape: has EA refresh the running auctions between two reads of the watch list', async () => {
    const shape = createObservableShape(1_000);
    const svc = biddingServices();
    const running = itemEntity(auctionSpec(901, { currentBid: 8_400, bidState: 'highest' }));
    const ended = itemEntity(auctionSpec(902, { currentBid: 9_000, bidState: 'outbid', tradeState: 'closed' }));
    const fresh = itemEntity(auctionSpec(901, { currentBid: 8_500, bidState: 'outbid', expires: 20 }));
    const refreshAuctions = vi.fn((_items: unknown[]): unknown => observable({ success: true }));
    const services = { Item: { ...svc.services.Item, refreshAuctions } };
    svc.requestWatchedItems.mockReturnValueOnce(observable({ success: true, data: { items: [running, ended] } }));
    svc.requestWatchedItems.mockReturnValueOnce(observable({ success: true, data: { items: [fresh, ended] } }));
    const read = await shape.bidding!.readWatchlist(services);
    // Only the running auction is refreshed, then the list read again.
    expect(refreshAuctions).toHaveBeenCalledWith([running]);
    expect(services.Item.clearTransferMarketCache).toHaveBeenCalled();
    expect(svc.requestWatchedItems).toHaveBeenCalledTimes(2);
    expect(read.entries).toEqual([fresh, ended]);

    // A refresh that fails leaves the first read standing.
    refreshAuctions.mockReturnValueOnce(observable({ success: false }));
    svc.requestWatchedItems.mockReturnValueOnce(observable({ success: true, data: { items: [running] } }));
    expect((await shape.bidding!.readWatchlist(services)).entries).toEqual([running]);
    // A refresh that never answers does not hold the read either.
    refreshAuctions.mockReturnValueOnce(observable({ success: true }, false));
    svc.requestWatchedItems.mockReturnValueOnce(observable({ success: true, data: { items: [running] } }));
    expect((await shape.bidding!.readWatchlist(services)).entries).toEqual([running]);
    // A page without refreshAuctions reads the list once.
    svc.requestWatchedItems.mockClear();
    svc.requestWatchedItems.mockReturnValueOnce(observable({ success: true, data: { items: [running] } }));
    expect((await shape.bidding!.readWatchlist(svc.services)).entries).toEqual([running]);
    expect(svc.requestWatchedItems).toHaveBeenCalledTimes(1);
  });

  it("observable shape: reads the live web app's watch list, its list inside `response`", async () => {
    const shape = createObservableShape(1_000);
    const svc = biddingServices();
    const watched = [itemEntity(auctionSpec(901, { currentBid: 10_000, bidState: 'highest' }))];
    // The envelope keys the live web app answered with (keys: error, maxAge,
    // response, retryAfter, status, success).
    const envelope = (response: unknown) => ({ success: true, status: 200, error: null, response, maxAge: 0, retryAfter: 0 });
    svc.requestWatchedItems.mockReturnValueOnce(observable(envelope({ items: watched })));
    expect((await shape.bidding!.readWatchlist(svc.services)).entries).toEqual(watched);
    svc.requestWatchedItems.mockReturnValueOnce(observable(envelope({ auctionInfo: watched })));
    expect((await shape.bidding!.readWatchlist(svc.services)).entries).toEqual(watched);
    svc.requestWatchedItems.mockReturnValueOnce(observable(envelope(watched)));
    expect((await shape.bidding!.readWatchlist(svc.services)).entries).toEqual(watched);
    // An empty watch list is empty, not an error.
    svc.requestWatchedItems.mockReturnValueOnce(observable(envelope({ items: [] })));
    expect((await shape.bidding!.readWatchlist(svc.services)).entries).toEqual([]);
    // Still no list anywhere: the error names what `response` held.
    svc.requestWatchedItems.mockReturnValueOnce(observable(envelope({ total: 0 })));
    await expect(shape.bidding!.readWatchlist(svc.services)).rejects.toThrow(/response keys: total/);
  });
});
