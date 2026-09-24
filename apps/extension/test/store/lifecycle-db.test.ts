// The trade lifecycle over its real IndexedDB store (fake-indexeddb): a
// sale persisted by one run is not reported again by the next (a reload,
// or a restarted service worker).

import { describe, expect, it } from 'vitest';

import { TradeLifecycle } from '../../src/lib/trade-lifecycle.js';
import { _resetForTests, idbLifecycleStore } from '../../src/store/lifecycle-db.js';

import type { Trade } from '@sl/shared';

describe('store/lifecycle-db', () => {
  it('persists lifecycle state so a sale is reported once across restarts', async () => {
    const reported: Trade[] = [];
    const run = () => new TradeLifecycle({ store: idbLifecycleStore, reportSale: (t) => void reported.push(t) });
    const sold = { itemId: '42', tradeId: '8001', resourceId: 7, rating: 80, tradeState: 'closed' as const, currentBid: 2_000, buyNowPrice: 2_000, expires: 0 };

    const first = run();
    await first.recordBuy({ itemId: '42', tradeId: '5001', resourceId: 7, rating: 80, buyPrice: 1_000, boughtAt: new Date(Date.now() - 60_000).toISOString() });
    await first.observePile([sold]);
    expect(reported).toHaveLength(1);

    await _resetForTests();
    const second = run();
    expect(await second.resumeUnreported()).toBe(0);
    await second.observePile([sold]);
    expect(reported).toHaveLength(1);
    expect(await idbLifecycleStore.get('42')).toMatchObject({ state: 'sold', saleReported: true, sellPrice: 2_000, buyTradeId: '5001' });
  });
});
