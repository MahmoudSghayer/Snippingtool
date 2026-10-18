// The trade lifecycle (lib/trade-lifecycle.ts), defect C13: a card the
// engine bought is followed through the trader's own trade pile, keyed by
// EA's itemId (a relist gets a new tradeId, the item keeps its id), and
// its sale is reported exactly once, against the buy's tradeId, with no
// tax or profit figures of the client's own.

import { computeTradeProfit, MAX_COIN_PRICE, type LifecycleBuy, type OpenTrade, type Trade, type TradePileItem } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { createMemoryLifecycleStore, queueSale, TradeLifecycle, type LifecycleRecord, type LifecycleStore } from '../../src/lib/trade-lifecycle.js';

const T0 = Date.parse('2026-09-24T10:00:00.000Z');
const DAY = 24 * 3600_000;

function buy(overrides: Partial<LifecycleBuy> = {}): LifecycleBuy {
  return {
    itemId: '900001',
    tradeId: '5001',
    resourceId: 50_331_700,
    rating: 88,
    buyPrice: 10_000,
    boughtAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

function pile(overrides: Partial<TradePileItem> = {}): TradePileItem {
  return {
    itemId: '900001',
    tradeId: '7001',
    resourceId: 50_331_700,
    rating: 88,
    tradeState: 'active',
    currentBid: 0,
    buyNowPrice: 14_000,
    expires: 3600,
    ...overrides,
  };
}

/** The card listed as trade 7001, then that listing sold. */
const LISTED = pile({ tradeState: 'active' });
const SOLD = pile({ tradeState: 'closed', currentBid: 13_500 });

function setup(store: LifecycleStore = createMemoryLifecycleStore()) {
  const reported: Trade[] = [];
  const clock = { now: T0 + 60_000 };
  const lifecycle = new TradeLifecycle({
    store,
    reportSale: (trade) => {
      reported.push(trade);
    },
    now: () => clock.now,
  });
  return { lifecycle, reported, store, clock };
}

describe('trade lifecycle', () => {
  it('buy -> list -> sold reports one sale, on the buy tradeId, at the sale price', async () => {
    const { lifecycle, reported } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([LISTED]);
    expect(reported).toHaveLength(0);

    await lifecycle.observePile([SOLD]);
    expect(reported).toHaveLength(1);
    const sale = reported[0]!;
    expect(sale).toMatchObject({
      tradeId: '5001',
      resourceId: 50_331_700,
      rating: 88,
      buyPrice: 10_000,
      sellPrice: 13_500,
      status: 'sold',
      boughtAt: new Date(T0).toISOString(),
      // The server is the only profit calculator.
      netProfit: null,
    });
    expect(Date.parse(sale.soldAt!)).toBeGreaterThanOrEqual(Date.parse(sale.boughtAt));
  });

  it('never reports the purchase itself as a sale: the bought auction shown closed (watch list, trade status) is ignored', async () => {
    const { lifecycle, reported, store } = setup();
    await lifecycle.recordBuy(buy());
    // EA shows the auction the trader won as closed at the price paid.
    await lifecycle.observePile([pile({ tradeId: '5001', tradeState: 'closed', currentBid: 10_000 })]);
    await lifecycle.observePile([pile({ tradeId: '5001', tradeState: 'active' })]);
    expect(reported).toHaveLength(0);
    expect((await store.get('900001'))?.state).toBe('bought');
  });

  it("a listing never seen still sells: closed straight from bought on the card's own tradeId is its sale", async () => {
    // Auto-sell listed the card, and no trade-pile load was read while it
    // was up (EA answered the reloads with errors): the sale is the first
    // the lifecycle sees of it. Such cards used to stay `bought` for good.
    const { lifecycle, reported, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([SOLD]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ tradeId: '5001', sellPrice: 13_500, status: 'sold' });
    expect(await store.get('900001')).toMatchObject({ state: 'sold', listTradeId: '7001', relists: 0 });
    // Seen again (a duplicate load, or listed then sold as reported): once.
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([SOLD]);
    expect(reported).toHaveLength(1);
  });

  it('expired straight from bought is followed too, and its relist sells', async () => {
    const { lifecycle, reported, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([pile({ tradeState: 'expired' })]);
    expect(await store.get('900001')).toMatchObject({ state: 'expired', listTradeId: '7001' });
    await lifecycle.observePile([pile({ tradeId: '7002', tradeState: 'closed', currentBid: 12_500 })]);
    expect(reported).toHaveLength(1);
    expect(await store.get('900001')).toMatchObject({ state: 'sold', sellPrice: 12_500, relists: 1 });
  });

  it('a relist never seen active still sells: any other closed tradeId of a listed card is its own later listing', async () => {
    const { lifecycle, reported, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([pile({ tradeState: 'expired' })]);
    // "Relist all" (no auctionInfo in its response), then sold as 7999
    // before the pile was next opened.
    await lifecycle.observePile([pile({ tradeId: '7999', tradeState: 'closed', currentBid: 12_000 })]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ tradeId: '5001', sellPrice: 12_000 });
    expect(await store.get('900001')).toMatchObject({ listTradeId: '7999', relists: 1 });
  });

  it('follows an expired -> relisted -> sold chain to one sale at the final price', async () => {
    const { lifecycle, reported, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([pile({ tradeId: '7001', tradeState: 'active', buyNowPrice: 16_000 })]);
    await lifecycle.observePile([pile({ tradeId: '7001', tradeState: 'expired', buyNowPrice: 16_000 })]);
    expect((await store.get('900001'))?.state).toBe('expired');

    // A relist is a new listing: a new tradeId for the same item.
    await lifecycle.observePile([pile({ tradeId: '7002', tradeState: 'active', buyNowPrice: 14_500 })]);
    expect(await store.get('900001')).toMatchObject({ state: 'listed', listTradeId: '7002', listPrice: 14_500, relists: 1 });

    await lifecycle.observePile([pile({ tradeId: '7002', tradeState: 'closed', currentBid: 14_500, buyNowPrice: 14_500 })]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ tradeId: '5001', sellPrice: 14_500, status: 'sold' });
  });

  it('does not double-report a duplicate trade-pile response, even in one batch or concurrently', async () => {
    const { lifecycle, reported } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([LISTED]);
    await Promise.all([lifecycle.observePile([SOLD, SOLD]), lifecycle.observePile([SOLD])]);
    await lifecycle.observePile([SOLD]);
    expect(reported).toHaveLength(1);
  });

  it('does not report a sale again after a reload (state persisted in the store)', async () => {
    const store = createMemoryLifecycleStore();
    const first = setup(store);
    await first.lifecycle.recordBuy(buy());
    await first.lifecycle.observePile([LISTED]);
    await first.lifecycle.observePile([SOLD]);
    expect(first.reported).toHaveLength(1);

    const second = setup(store);
    await second.lifecycle.resumeUnreported();
    await second.lifecycle.observePile([SOLD]);
    expect(second.reported).toHaveLength(0);
  });

  it('re-sends a sale whose report failed, and a new buy never overwrites it meanwhile', async () => {
    const store = createMemoryLifecycleStore();
    const failing = new TradeLifecycle({
      store,
      reportSale: () => {
        throw new Error('not queued');
      },
      now: () => T0 + 60_000,
    });
    await failing.recordBuy(buy());
    await failing.observePile([LISTED]);
    await failing.observePile([SOLD]);
    await failing.recordBuy(buy({ tradeId: '5999', buyPrice: 1 }));

    const retry = setup(store);
    expect(await retry.lifecycle.resumeUnreported()).toBe(1);
    expect(retry.reported).toHaveLength(1);
    expect(retry.reported[0]).toMatchObject({ tradeId: '5001', buyPrice: 10_000, sellPrice: 13_500 });
    expect(await retry.lifecycle.resumeUnreported()).toBe(0);
  });

  it('ignores items it has no buy for, and a sale or listing with no or an out-of-range price', async () => {
    const { lifecycle, reported, store } = setup();
    await lifecycle.observePile([pile({ itemId: '123', tradeState: 'closed', currentBid: 9_000 })]);
    expect(reported).toHaveLength(0);
    expect(await store.get('123')).toBeUndefined();

    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([pile({ buyNowPrice: MAX_COIN_PRICE + 1 })]);
    expect((await store.get('900001'))?.state).toBe('bought');
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([pile({ tradeState: 'closed', currentBid: 0, buyNowPrice: 0 })]);
    await lifecycle.observePile([pile({ tradeState: 'closed', currentBid: MAX_COIN_PRICE + 1 })]);
    expect(reported).toHaveLength(0);
  });

  it('never reports a sale time before the purchase time', async () => {
    const { lifecycle, reported } = setup();
    // The buy's time came from a clock ahead of this one.
    await lifecycle.recordBuy(buy({ boughtAt: new Date(T0 + 10 * 60_000).toISOString() }));
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([SOLD]);
    expect(reported[0]!.soldAt).toBe(new Date(T0 + 10 * 60_000).toISOString());
  });

  it('keeps the first buy when the same item is reported bought twice', async () => {
    const { lifecycle, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ tradeId: '5999', buyPrice: 1 }));
    expect(await store.get('900001')).toMatchObject({ buyTradeId: '5001', buyPrice: 10_000 });
  });

  it('counts a buy with no item id, and the items it follows and sales it reported', async () => {
    const { lifecycle } = setup();
    await lifecycle.recordBuy(buy({ itemId: null }));
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ itemId: '900002', tradeId: '5002' }));
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([SOLD]);
    expect(await lifecycle.stats()).toEqual({ buysWithoutItemId: 1, followed: 1, salesReported: 1 });
  });

  it('keeps the buys-without-item-id count across a restart when given a counter store', async () => {
    let saved = 0;
    const counter = { get: async () => saved, set: async (n: number) => void (saved = n) };
    const store = createMemoryLifecycleStore();
    const first = new TradeLifecycle({ store, reportSale: () => undefined, counter });
    await first.recordBuy(buy({ itemId: null }));
    const second = new TradeLifecycle({ store, reportSale: () => undefined, counter });
    await second.recordBuy(buy({ itemId: null }));
    expect((await second.stats()).buysWithoutItemId).toBe(2);
  });

  it('a listed card missing from a full trade pile sold: reported once, inferred, at its list price', async () => {
    // EA lets nobody remove a card whose listing is live: the trader
    // cleared it from the sold items on the console, or every pile read
    // failed while it sold.
    const { lifecycle, reported, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ itemId: '900002', tradeId: '5002' }));
    await lifecycle.recordBuy(buy({ itemId: '900003', tradeId: '5003' }));
    await lifecycle.observePile([LISTED, pile({ itemId: '900002', tradeId: '7002', tradeState: 'active', buyNowPrice: 20_000 })]);
    expect((await lifecycle.sessionPnl(T0)).unrealised).toBe(34_000);

    // A partial response (not the full pile) proves nothing.
    await lifecycle.observePile([pile({ itemId: '900002', tradeId: '7002', tradeState: 'active', buyNowPrice: 20_000 })]);
    expect((await store.get('900001'))?.state).toBe('listed');
    expect(reported).toHaveLength(0);

    await lifecycle.observePile([pile({ itemId: '900002', tradeId: '7002', tradeState: 'active', buyNowPrice: 20_000 })], { full: true });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      tradeId: '5001',
      itemId: '900001',
      buyPrice: 10_000,
      sellPrice: 14_000,
      status: 'sold',
      saleSource: 'inferred',
      netProfit: null,
    });
    expect(await store.get('900001')).toMatchObject({ state: 'sold', sellPrice: 14_000, saleSource: 'inferred', saleReported: true });
    // Never listed: may simply be in the club or unassigned; left alone.
    expect((await store.get('900003'))?.state).toBe('bought');
    expect(await lifecycle.sessionPnl(T0)).toMatchObject({ unrealised: 20_000, listed: 1, sales: 1, realised: computeTradeProfit(10_000, 14_000).netProfit });

    // Another full pile, or the sale seen after all: still one report.
    await lifecycle.observePile([], { full: true });
    await lifecycle.observePile([SOLD]);
    expect(reported.filter((t) => t.tradeId === '5001')).toHaveLength(1);
  });

  it('an expired card missing from a full trade pile is gone, never reported: it may have been quick-sold or sent to the club', async () => {
    const { lifecycle, reported, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([pile({ tradeState: 'expired' })]);
    await lifecycle.observePile([], { full: true });
    expect(await store.get('900001')).toMatchObject({ state: 'gone', goneFrom: 'expired', listPrice: 14_000 });
    expect(reported).toHaveLength(0);
    // Not even by the one-off report of old `gone` records.
    expect(await lifecycle.resumeUnreported()).toBe(0);
    expect(reported).toHaveLength(0);
  });

  it('a gone item seen listed again is followed again, and its sale still reported', async () => {
    const { lifecycle, reported } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([pile({ tradeState: 'expired' })]);
    await lifecycle.observePile([], { full: true });
    await lifecycle.observePile([pile({ tradeId: '7002', tradeState: 'active' })]);
    await lifecycle.observePile([pile({ tradeId: '7002', tradeState: 'closed', currentBid: 13_000 })]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ tradeId: '5001', sellPrice: 13_000 });
    // A sale seen is the server's default source: left out of the report.
    expect(reported[0]).not.toHaveProperty('saleSource');
  });

  it('never dates an inferred sale before the purchase', async () => {
    const { lifecycle, reported } = setup();
    await lifecycle.recordBuy(buy({ boughtAt: new Date(T0 + 10 * 60_000).toISOString() }));
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([], { full: true });
    expect(reported[0]!.soldAt).toBe(new Date(T0 + 10 * 60_000).toISOString());
  });

  it('retries an inferred sale whose report failed, once', async () => {
    const store = createMemoryLifecycleStore();
    const failing = new TradeLifecycle({
      store,
      reportSale: () => {
        throw new Error('not queued');
      },
      now: () => T0 + 60_000,
    });
    await failing.recordBuy(buy());
    await failing.observePile([LISTED]);
    expect(await failing.observePile([], { full: true })).toBe(0);
    expect(await store.get('900001')).toMatchObject({ state: 'sold', saleReported: false });

    const retry = setup(store);
    expect(await retry.lifecycle.resumeUnreported()).toBe(1);
    expect(retry.reported[0]).toMatchObject({ tradeId: '5001', sellPrice: 14_000, saleSource: 'inferred' });
    expect(await retry.lifecycle.resumeUnreported()).toBe(0);
  });

  it('prunes reported sales and gone items after 30 days, and keeps everything else', async () => {
    const store = createMemoryLifecycleStore();
    const { lifecycle, clock } = setup(store);
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ itemId: '900002', tradeId: '5002' }));
    await lifecycle.recordBuy(buy({ itemId: '900003', tradeId: '5003' }));
    await lifecycle.observePile([LISTED, pile({ itemId: '900002', tradeId: '7002' })]);
    await lifecycle.observePile([SOLD], { full: true }); // 900001 sold, 900002 sold (inferred)

    clock.now += 29 * DAY;
    await lifecycle.prune();
    expect((await store.all()).map((r) => r.itemId).sort()).toEqual(['900001', '900002', '900003']);

    clock.now += 2 * DAY;
    await lifecycle.prune();
    expect((await store.all()).map((r) => r.itemId)).toEqual(['900003']);
  });

  it('session P&L: realised net of tax from sales since the session began, plus listed items at list price', async () => {
    const { lifecycle } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ itemId: '900002', tradeId: '5002', buyPrice: 20_000 }));
    await lifecycle.recordBuy(buy({ itemId: '900003', tradeId: '5003', buyPrice: 3_000 }));
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([SOLD, pile({ itemId: '900002', tradeId: '7002', tradeState: 'active', buyNowPrice: 25_000 })]);

    const pnl = await lifecycle.sessionPnl(T0);
    expect(pnl).toEqual({
      realised: computeTradeProfit(10_000, 13_500).netProfit,
      unrealised: 25_000,
      sales: 1,
      listed: 1,
      since: T0,
    });
    // A sale before the session began is not this session's.
    expect((await lifecycle.sessionPnl(T0 + DAY)).realised).toBe(0);
  });
});

/** A record as the store holds it, for records written by older versions. */
function stored(overrides: Partial<LifecycleRecord>): LifecycleRecord {
  return {
    itemId: '900001',
    buyTradeId: '5001',
    resourceId: 50_331_700,
    rating: 88,
    buyPrice: 10_000,
    boughtAt: new Date(T0).toISOString(),
    state: 'bought',
    listTradeId: null,
    listPrice: null,
    relists: 0,
    sellPrice: null,
    soldAt: null,
    saleReported: false,
    updatedAt: T0,
    ...overrides,
  };
}

describe('old `gone` records (from before goneFrom)', () => {
  it('are reported once as sold at their list price, dated when they went gone, by resumeUnreported', async () => {
    const store = createMemoryLifecycleStore();
    const goneAt = T0 + 3_600_000;
    // Left the pile listed or expired: an old record cannot say which. The
    // trader confirmed those cards sold.
    await store.put(stored({ state: 'gone', listTradeId: '7001', listPrice: 14_000, updatedAt: goneAt }));
    await store.put(stored({ itemId: '900002', buyTradeId: '5002', state: 'gone', listTradeId: '7002', listPrice: 21_000, updatedAt: goneAt }));
    // No list price: nothing to report it at.
    await store.put(stored({ itemId: '900003', buyTradeId: '5003', state: 'gone', updatedAt: goneAt }));
    // A new-style gone record (left the pile expired) is never reported.
    await store.put(stored({ itemId: '900004', buyTradeId: '5004', state: 'gone', goneFrom: 'expired', listPrice: 9_000, updatedAt: goneAt }));

    const { lifecycle, reported } = setup(store);
    expect(await lifecycle.resumeUnreported()).toBe(2);
    expect(reported.map((t) => [t.tradeId, t.sellPrice, t.saleSource])).toEqual([
      ['5001', 14_000, 'inferred'],
      ['5002', 21_000, 'inferred'],
    ]);
    expect(reported[0]).toMatchObject({ itemId: '900001', buyPrice: 10_000, status: 'sold', soldAt: new Date(goneAt).toISOString() });
    expect((await store.get('900001'))?.state).toBe('sold');
    expect((await store.get('900003'))?.state).toBe('gone');

    // Once: neither this instance nor the next (a reload) reports them again.
    expect(await lifecycle.resumeUnreported()).toBe(0);
    const reloaded = setup(store);
    expect(await reloaded.lifecycle.resumeUnreported()).toBe(0);
    await reloaded.lifecycle.observePile([], { full: true });
    expect(reloaded.reported).toHaveLength(0);
  });

  it('one whose report fails is retried, still once', async () => {
    const store = createMemoryLifecycleStore();
    await store.put(stored({ state: 'gone', listTradeId: '7001', listPrice: 14_000 }));
    const failing = new TradeLifecycle({
      store,
      reportSale: () => {
        throw new Error('signed out');
      },
      now: () => T0 + 60_000,
    });
    expect(await failing.resumeUnreported()).toBe(0);
    const retry = setup(store);
    expect(await retry.lifecycle.resumeUnreported()).toBe(1);
    expect(await retry.lifecycle.resumeUnreported()).toBe(0);
    expect(retry.reported).toHaveLength(1);
  });
});

function openTrade(overrides: Partial<OpenTrade> = {}): OpenTrade {
  return {
    tradeId: '5001',
    itemId: '900001',
    resourceId: 50_331_700,
    rating: 88,
    buyPrice: 10_000,
    boughtAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe('seeding from the account’s open trades (cross-browser)', () => {
  it('follows a card another browser bought, and reports its sale with that buy’s tradeId', async () => {
    // Browser A (the trader's PC) bought the card and reported the buy.
    const a = setup();
    await a.lifecycle.recordBuy(buy());

    // Browser B (a cloud machine) runs the bot later: its own store knows
    // nothing until it seeds from /extension/open-trades.
    const b = setup();
    await b.lifecycle.observePile([SOLD]);
    expect(b.reported).toHaveLength(0);

    expect(await b.lifecycle.seed([openTrade()])).toBe(1);
    expect(await b.store.get('900001')).toMatchObject({ state: 'bought', buyTradeId: '5001', seeded: true });
    await b.lifecycle.observePile([LISTED]);
    await b.lifecycle.observePile([SOLD]);
    expect(b.reported).toHaveLength(1);
    expect(b.reported[0]).toMatchObject({
      tradeId: '5001',
      itemId: '900001',
      resourceId: 50_331_700,
      rating: 88,
      buyPrice: 10_000,
      boughtAt: new Date(T0).toISOString(),
      sellPrice: 13_500,
      status: 'sold',
    });
  });

  it('infers the sale of a seeded card seen listed that then left the pile', async () => {
    const b = setup();
    await b.lifecycle.seed([openTrade()]);
    await b.lifecycle.observePile([LISTED]);
    await b.lifecycle.observePile([], { full: true });
    expect(b.reported).toEqual([expect.objectContaining({ tradeId: '5001', sellPrice: 14_000, saleSource: 'inferred' })]);
  });

  it('never overwrites a record this browser already has, whatever its state', async () => {
    const store = createMemoryLifecycleStore();
    await store.put(stored({ itemId: '1', buyTradeId: 'local-1', state: 'listed', listTradeId: '7001', listPrice: 14_000 }));
    await store.put(stored({ itemId: '2', buyTradeId: 'local-2', state: 'sold', sellPrice: 13_000, soldAt: new Date(T0).toISOString(), saleReported: false }));
    await store.put(stored({ itemId: '3', buyTradeId: 'local-3', state: 'expired', listTradeId: '7003', listPrice: 9_000 }));
    // An old gone record waiting for its one-off report.
    await store.put(stored({ itemId: '4', buyTradeId: 'local-4', state: 'gone', listPrice: 9_000 }));
    await store.put(stored({ itemId: '5', buyTradeId: '5005', state: 'bought' }));
    const { lifecycle } = setup(store);

    const later = new Date(T0 + 60_000).toISOString();
    const added = await lifecycle.seed([
      openTrade({ itemId: '1', tradeId: 'server-1', boughtAt: later }),
      openTrade({ itemId: '2', tradeId: 'server-2', boughtAt: later }),
      openTrade({ itemId: '3', tradeId: 'server-3', boughtAt: later }),
      openTrade({ itemId: '4', tradeId: 'server-4', boughtAt: later }),
      openTrade({ itemId: '5', tradeId: '5005', buyPrice: 1 }),
    ]);
    expect(added).toBe(0);
    expect(await store.get('1')).toMatchObject({ buyTradeId: 'local-1', state: 'listed' });
    expect(await store.get('2')).toMatchObject({ buyTradeId: 'local-2', state: 'sold', saleReported: false });
    expect(await store.get('3')).toMatchObject({ buyTradeId: 'local-3', state: 'expired' });
    expect(await store.get('4')).toMatchObject({ buyTradeId: 'local-4', state: 'gone' });
    expect(await store.get('5')).toMatchObject({ buyTradeId: '5005', buyPrice: 10_000 });
  });

  it('starts afresh for a card bought again after an earlier purchase here finished', async () => {
    const store = createMemoryLifecycleStore();
    await store.put(stored({ itemId: '1', buyTradeId: 'first', state: 'sold', sellPrice: 13_000, soldAt: new Date(T0).toISOString(), saleReported: true }));
    await store.put(stored({ itemId: '2', buyTradeId: 'first-2', state: 'gone', goneFrom: 'expired', listPrice: 9_000 }));
    const { lifecycle } = setup(store);
    const later = new Date(T0 + 3_600_000).toISOString();
    expect(await lifecycle.seed([openTrade({ itemId: '1', tradeId: 'again', boughtAt: later }), openTrade({ itemId: '2', tradeId: 'again-2', boughtAt: later })])).toBe(2);
    expect(await store.get('1')).toMatchObject({ buyTradeId: 'again', state: 'bought', seeded: true });
    expect(await store.get('2')).toMatchObject({ buyTradeId: 'again-2', state: 'bought' });
    // An older purchase than the one finished here is not a new one.
    expect(await lifecycle.seed([openTrade({ itemId: '1', tradeId: 'older', boughtAt: new Date(T0 - 3_600_000).toISOString() })])).toBe(0);
  });

  it('never reports a sale twice: seeding again, or after the sale was reported, adds nothing', async () => {
    const b = setup();
    expect(await b.lifecycle.seed([openTrade()])).toBe(1);
    expect(await b.lifecycle.seed([openTrade()])).toBe(0);
    await b.lifecycle.observePile([SOLD]);
    // The server has not caught up yet and still lists the trade as open.
    expect(await b.lifecycle.seed([openTrade()])).toBe(0);
    await b.lifecycle.observePile([SOLD]);
    await b.lifecycle.observePile([], { full: true });
    expect(await b.lifecycle.resumeUnreported()).toBe(0);
    expect(b.reported).toHaveLength(1);
  });

  it('a complete list drops seeded cards still bought that are no longer open; a truncated one drops nothing', async () => {
    const b = setup();
    await b.lifecycle.recordBuy(buy({ itemId: 'local', tradeId: 'local-buy' }));
    await b.lifecycle.seed([openTrade({ itemId: '1', tradeId: 't1' }), openTrade({ itemId: '2', tradeId: 't2' }), openTrade({ itemId: '3', tradeId: 't3' })]);
    await b.lifecycle.observePile([pile({ itemId: '3', tradeId: '7003', tradeState: 'active' })]);

    // t1 sold elsewhere (or was recorded on the dashboard): no longer open.
    await b.lifecycle.seed([openTrade({ itemId: '2', tradeId: 't2' })], { complete: false });
    expect(await b.store.get('1')).toBeDefined();

    await b.lifecycle.seed([openTrade({ itemId: '2', tradeId: 't2' })], { complete: true });
    expect(await b.store.get('1')).toBeUndefined();
    expect(await b.store.get('2')).toMatchObject({ state: 'bought' });
    // Followed here (listed) or bought here: kept.
    expect(await b.store.get('3')).toMatchObject({ state: 'listed' });
    expect(await b.store.get('local')).toMatchObject({ state: 'bought' });
  });

  it('re-sends, once, the buys recorded before buy reports carried the item id, so other browsers can follow those cards', async () => {
    const store = createMemoryLifecycleStore();
    // Written by the previous version: no itemIdReported.
    await store.put(stored({ itemId: '1', buyTradeId: 'old-1', state: 'bought' }));
    await store.put(stored({ itemId: '2', buyTradeId: 'old-2', state: 'listed', listTradeId: '7002', listPrice: 14_000 }));
    await store.put(stored({ itemId: '3', buyTradeId: 'old-3', state: 'expired', listTradeId: '7003', listPrice: 14_000 }));
    // Finished, or the server already has the id: nothing to send.
    await store.put(stored({ itemId: '4', buyTradeId: 'old-4', state: 'sold', sellPrice: 13_000, soldAt: new Date(T0).toISOString(), saleReported: true }));
    await store.put(stored({ itemId: '5', buyTradeId: 'old-5', state: 'gone', goneFrom: 'expired' }));
    await store.put(stored({ itemId: '6', buyTradeId: 'seeded-6', seeded: true }));
    const { lifecycle, reported } = setup(store);
    // Bought with this version: its buy report already carried the id.
    await lifecycle.recordBuy(buy({ itemId: '7', tradeId: 'new-7' }));

    expect(await lifecycle.reportItemIds()).toBe(3);
    expect(reported.map((t) => [t.tradeId, t.itemId, t.status])).toEqual([
      ['old-1', '1', 'bought'],
      ['old-2', '2', 'bought'],
      ['old-3', '3', 'bought'],
    ]);
    expect(reported[0]).toMatchObject({ buyPrice: 10_000, boughtAt: new Date(T0).toISOString(), sellPrice: null, soldAt: null });
    expect(await lifecycle.reportItemIds()).toBe(0);
    // The records themselves are unchanged otherwise.
    expect(await store.get('2')).toMatchObject({ state: 'listed', listPrice: 14_000, itemIdReported: true });
  });

  it('retries an item-id re-send that could not be queued', async () => {
    const store = createMemoryLifecycleStore();
    await store.put(stored({ itemId: '1', buyTradeId: 'old-1', state: 'bought' }));
    const failing = new TradeLifecycle({
      store,
      reportSale: () => {
        throw new Error('signed out');
      },
    });
    expect(await failing.reportItemIds()).toBe(0);
    const retry = setup(store);
    expect(await retry.lifecycle.reportItemIds()).toBe(1);
  });

  it('prunes a seeded card bought over 30 days ago that this browser never saw', async () => {
    const { lifecycle, store, clock } = setup();
    await lifecycle.seed([openTrade({ itemId: '1', tradeId: 't1' })]);
    await lifecycle.recordBuy(buy({ itemId: 'local', tradeId: 'local-buy' }));
    clock.now = T0 + 31 * DAY;
    await lifecycle.prune();
    expect(await store.get('1')).toBeUndefined();
    // A buy made here is still followed (it may yet be listed).
    expect(await store.get('local')).toBeDefined();
  });
});

describe('queueSale (the reportSale background gives the lifecycle)', () => {
  const trade = { tradeId: '5001' } as Trade;

  it('counts a sale as reported only once it is queued and persisted', async () => {
    const order: string[] = [];
    const report = queueSale({
      enqueue: async () => {
        order.push('enqueue');
        return { queued: 1 };
      },
      persisted: async () => {
        order.push('persisted');
      },
      optedOut: async () => false,
    });
    await report(trade);
    expect(order).toEqual(['enqueue', 'persisted']);
  });

  it('throws (not reported, retried later) when nothing was queued, e.g. signed out', async () => {
    const report = queueSale({ enqueue: async () => ({ queued: 0 }), persisted: async () => undefined, optedOut: async () => false });
    await expect(report(trade)).rejects.toThrow();
  });

  it('treats an opted-out user\'s sale as done: it must never be sent', async () => {
    const report = queueSale({ enqueue: async () => ({ queued: 0 }), persisted: async () => undefined, optedOut: async () => true });
    await expect(report(trade)).resolves.toBeUndefined();
  });
});
