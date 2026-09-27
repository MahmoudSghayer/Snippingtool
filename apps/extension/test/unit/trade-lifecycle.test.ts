// The trade lifecycle (lib/trade-lifecycle.ts), defect C13: a card the
// engine bought is followed through the trader's own trade pile, keyed by
// EA's itemId (a relist gets a new tradeId, the item keeps its id), and
// its sale is reported exactly once, against the buy's tradeId, with no
// tax or profit figures of the client's own.

import { computeTradeProfit, MAX_COIN_PRICE, type LifecycleBuy, type Trade, type TradePileItem } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { createMemoryLifecycleStore, queueSale, TradeLifecycle, type LifecycleStore } from '../../src/lib/trade-lifecycle.js';

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

  it('a card never seen listed has no sale: closed straight from bought is ignored', async () => {
    const { lifecycle, reported } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([SOLD]);
    expect(reported).toHaveLength(0);
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([SOLD]);
    expect(reported).toHaveLength(1);
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

  it('a full trade pile without a listed or expired item marks it gone: no longer listed value', async () => {
    const { lifecycle, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ itemId: '900002', tradeId: '5002' }));
    await lifecycle.recordBuy(buy({ itemId: '900003', tradeId: '5003' }));
    await lifecycle.observePile([LISTED, pile({ itemId: '900002', tradeId: '7002', tradeState: 'active', buyNowPrice: 20_000 })]);
    expect((await lifecycle.sessionPnl(T0)).unrealised).toBe(34_000);

    // A partial response (not the full pile) proves nothing.
    await lifecycle.observePile([pile({ itemId: '900002', tradeId: '7002', tradeState: 'active', buyNowPrice: 20_000 })]);
    expect((await store.get('900001'))?.state).toBe('listed');

    await lifecycle.observePile([pile({ itemId: '900002', tradeId: '7002', tradeState: 'active', buyNowPrice: 20_000 })], { full: true });
    expect((await store.get('900001'))?.state).toBe('gone');
    // Never listed: may simply be in the club or unassigned; left alone.
    expect((await store.get('900003'))?.state).toBe('bought');
    expect(await lifecycle.sessionPnl(T0)).toMatchObject({ unrealised: 20_000, listed: 1, realised: 0 });
  });

  it('a gone item seen listed again is followed again, and its sale still reported', async () => {
    const { lifecycle, reported } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([LISTED]);
    await lifecycle.observePile([], { full: true });
    await lifecycle.observePile([SOLD]);
    expect(reported).toHaveLength(1);
  });

  it('prunes reported sales and gone items after 30 days, and keeps everything else', async () => {
    const store = createMemoryLifecycleStore();
    const { lifecycle, clock } = setup(store);
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ itemId: '900002', tradeId: '5002' }));
    await lifecycle.recordBuy(buy({ itemId: '900003', tradeId: '5003' }));
    await lifecycle.observePile([LISTED, pile({ itemId: '900002', tradeId: '7002' })]);
    await lifecycle.observePile([SOLD], { full: true }); // 900001 sold, 900002 gone

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
