// Defect C13, part 3: a bought trade's card fields come from the listing
// that was bought, never from whichever card the trader last searched.

import { describe, expect, it } from 'vitest';

import { buildBoughtTrade } from '../../src/lib/trade-report.js';

import type { TrimmedAuction } from '@sl/shared';

const BOUGHT_AT = '2026-09-24T10:00:00.000Z';

function listing(overrides: Partial<TrimmedAuction> = {}): TrimmedAuction {
  return {
    tradeId: '5001',
    resourceId: 50_331_700,
    assetId: 231_747,
    rating: 88,
    buyNow: 10_000,
    startingBid: 9_000,
    currentBid: 0,
    offers: 0,
    expiresAt: null,
    seenAt: 1,
    itemId: '900001',
    ...overrides,
  };
}

describe('buildBoughtTrade', () => {
  it('takes rating, resourceId and assetId from the traded listing, not the last card seen', () => {
    const { trade, lifecycle } = buildBoughtTrade({ tradeId: '5001', resourceId: 50_331_700, buyPrice: 10_000 }, listing({ rating: 91 }), BOUGHT_AT);
    expect(trade).toMatchObject({ tradeId: '5001', resourceId: 50_331_700, assetId: 231_747, rating: 91, buyPrice: 10_000, status: 'bought', boughtAt: BOUGHT_AT, sellPrice: null, netProfit: null, soldAt: null });
    expect(lifecycle).toEqual({ itemId: '900001', tradeId: '5001', resourceId: 50_331_700, rating: 91, buyPrice: 10_000, boughtAt: BOUGHT_AT });
  });

  it('leaves rating null rather than guessing when the listing is unknown, and cannot follow it without an item id', () => {
    const { trade, lifecycle } = buildBoughtTrade({ tradeId: '5001', resourceId: 7, buyPrice: 500 }, undefined, BOUGHT_AT);
    expect(trade).toMatchObject({ resourceId: 7, rating: null, assetId: null });
    expect(lifecycle).toBeNull();
    expect(buildBoughtTrade({ tradeId: '5001', resourceId: 7, buyPrice: 500 }, listing({ itemId: undefined }), BOUGHT_AT).lifecycle).toBeNull();
  });

  it('ignores a listing for a different trade', () => {
    const { trade } = buildBoughtTrade({ tradeId: '5002', resourceId: 7, buyPrice: 500 }, listing({ rating: 91 }), BOUGHT_AT);
    expect(trade.rating).toBeNull();
  });
});
