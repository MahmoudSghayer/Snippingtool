// The trade lifecycle (lib/trade-lifecycle.ts), defect C13: a card the
// engine bought is followed through the trader's own trade pile, keyed by
// EA's itemId (a relist gets a new tradeId, the item keeps its id), and
// its sale is reported exactly once, against the buy's tradeId, with no
// tax or profit figures of the client's own.

import { computeTradeProfit, type LifecycleBuy, type Trade, type TradePileItem } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { createMemoryLifecycleStore, TradeLifecycle } from '../../src/lib/trade-lifecycle.js';

const T0 = Date.parse('2026-09-24T10:00:00.000Z');

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

function setup(store = createMemoryLifecycleStore()) {
  const reported: Trade[] = [];
  let clock = T0 + 60_000;
  const lifecycle = new TradeLifecycle({
    store,
    reportSale: (trade) => {
      reported.push(trade);
    },
    now: () => clock,
  });
  return {
    lifecycle,
    reported,
    store,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('trade lifecycle', () => {
  it('buy -> list -> sold reports one sale, on the buy tradeId, at the sale price', async () => {
    const { lifecycle, reported } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([pile({ tradeState: 'active' })]);
    expect(reported).toHaveLength(0);

    await lifecycle.observePile([pile({ tradeState: 'closed', currentBid: 13_500 })]);
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

  it('follows an expired -> relisted -> sold chain to one sale at the final price', async () => {
    const { lifecycle, reported, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([pile({ tradeId: '7001', tradeState: 'active', buyNowPrice: 16_000 })]);
    await lifecycle.observePile([pile({ tradeId: '7001', tradeState: 'expired', buyNowPrice: 16_000 })]);
    expect((await store.get('900001'))?.state).toBe('expired');

    // A relist is a new listing: a new tradeId for the same item.
    await lifecycle.observePile([pile({ tradeId: '7002', tradeState: 'active', buyNowPrice: 14_500 })]);
    const relisted = await store.get('900001');
    expect(relisted).toMatchObject({ state: 'listed', listTradeId: '7002', listPrice: 14_500, relists: 1 });

    await lifecycle.observePile([pile({ tradeId: '7002', tradeState: 'closed', currentBid: 14_500, buyNowPrice: 14_500 })]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ tradeId: '5001', sellPrice: 14_500, status: 'sold' });
  });

  it('does not double-report a duplicate trade-pile response, even in one batch or concurrently', async () => {
    const { lifecycle, reported } = setup();
    await lifecycle.recordBuy(buy());
    const sold = pile({ tradeState: 'closed', currentBid: 13_500 });
    await Promise.all([lifecycle.observePile([sold, sold]), lifecycle.observePile([sold])]);
    await lifecycle.observePile([sold]);
    expect(reported).toHaveLength(1);
  });

  it('does not report a sale again after a reload (state persisted in the store)', async () => {
    const store = createMemoryLifecycleStore();
    const first = setup(store);
    await first.lifecycle.recordBuy(buy());
    await first.lifecycle.observePile([pile({ tradeState: 'closed', currentBid: 13_500 })]);
    expect(first.reported).toHaveLength(1);

    const second = setup(store);
    await second.lifecycle.resumeUnreported();
    await second.lifecycle.observePile([pile({ tradeState: 'closed', currentBid: 13_500 })]);
    expect(second.reported).toHaveLength(0);
  });

  it('re-sends a sale whose report failed, after a reload', async () => {
    const store = createMemoryLifecycleStore();
    const failing = new TradeLifecycle({
      store,
      reportSale: () => {
        throw new Error('background went away');
      },
      now: () => T0 + 60_000,
    });
    await failing.recordBuy(buy());
    await failing.observePile([pile({ tradeState: 'closed', currentBid: 13_500 })]);

    const retry = setup(store);
    expect(await retry.lifecycle.resumeUnreported()).toBe(1);
    expect(retry.reported).toHaveLength(1);
    expect(await retry.lifecycle.resumeUnreported()).toBe(0);
  });

  it('ignores items it has no buy for, and a sale with no price', async () => {
    const { lifecycle, reported, store } = setup();
    await lifecycle.observePile([pile({ itemId: '123', tradeState: 'closed', currentBid: 9_000 })]);
    expect(reported).toHaveLength(0);
    expect(await store.get('123')).toBeUndefined();

    await lifecycle.recordBuy(buy());
    await lifecycle.observePile([pile({ tradeState: 'closed', currentBid: 0, buyNowPrice: 0 })]);
    expect(reported).toHaveLength(0);
  });

  it('never reports a sale time before the purchase time', async () => {
    const { lifecycle, reported } = setup();
    // The buy's time came from a clock ahead of this one.
    await lifecycle.recordBuy(buy({ boughtAt: new Date(T0 + 10 * 60_000).toISOString() }));
    await lifecycle.observePile([pile({ tradeState: 'closed', currentBid: 13_500 })]);
    expect(reported[0]!.soldAt).toBe(new Date(T0 + 10 * 60_000).toISOString());
  });

  it('keeps the first buy when the same item is reported bought twice', async () => {
    const { lifecycle, store } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ tradeId: '5999', buyPrice: 1 }));
    expect(await store.get('900001')).toMatchObject({ buyTradeId: '5001', buyPrice: 10_000 });
  });

  it('session P&L: realised net of tax from sales since the session began, plus listed items at list price', async () => {
    const { lifecycle } = setup();
    await lifecycle.recordBuy(buy());
    await lifecycle.recordBuy(buy({ itemId: '900002', tradeId: '5002', buyPrice: 20_000 }));
    await lifecycle.recordBuy(buy({ itemId: '900003', tradeId: '5003', buyPrice: 3_000 }));
    await lifecycle.observePile([
      pile({ tradeState: 'closed', currentBid: 13_500 }),
      pile({ itemId: '900002', tradeId: '7002', tradeState: 'active', buyNowPrice: 25_000 }),
    ]);

    const pnl = await lifecycle.sessionPnl(T0);
    expect(pnl).toEqual({
      realised: computeTradeProfit(10_000, 13_500).netProfit,
      unrealised: 25_000,
      sales: 1,
      listed: 1,
      since: T0,
    });
    // A sale before the session began is not this session's.
    expect((await lifecycle.sessionPnl(T0 + 24 * 3600_000)).realised).toBe(0);
  });
});
