import { describe, expect, it } from 'vitest';

import {
  breakEvenListPrice,
  closeTradeRequestSchema,
  computeTradeProfit,
  EA_TAX_RATE,
  MARK_SOLD_MAX_TRADES,
  markTradesSoldRequestSchema,
  OPEN_TRADES_MAX,
  openTradeSchema,
  openTradesResponseSchema,
  SALE_SOURCES,
  tradeIngestSchema,
  tradeSchema,
  tradeSellPriceQuerySchema,
} from '../../src/schemas/trades.js';

describe('computeTradeProfit', () => {
  it('applies the 5% EA tax to the sale and subtracts the purchase', () => {
    expect(computeTradeProfit(20000, 30000)).toEqual({ eaTaxCoins: 1500, netProfit: 8500 });
  });

  it('rounds the tax to whole coins and keeps the net an exact integer', () => {
    // 5% of 1234 is 61.7 -> 62 coins of tax.
    expect(computeTradeProfit(1000, 1234)).toEqual({ eaTaxCoins: 62, netProfit: 172 });
  });

  it('reports a loss as a negative net', () => {
    expect(computeTradeProfit(10000, 9000)).toEqual({ eaTaxCoins: 450, netProfit: -1450 });
  });

  it('a quick-sell for zero costs the full purchase price', () => {
    expect(computeTradeProfit(750, 0)).toEqual({ eaTaxCoins: 0, netProfit: -750 });
  });

  it('defaults to EA_TAX_RATE but accepts an explicit rate', () => {
    expect(EA_TAX_RATE).toBe(0.05);
    expect(computeTradeProfit(100, 200, 0)).toEqual({ eaTaxCoins: 0, netProfit: 100 });
  });
});

describe('breakEvenListPrice', () => {
  it('is the lowest grid price whose after-tax proceeds cover the cost', () => {
    // 46,250 cost: 48,750 nets floor(48,750 * 0.95) = 46,312 >= 46,250, and
    // the step below (48,500) nets 46,075, a loss.
    expect(breakEvenListPrice(46_250)).toBe(48_750);
    expect(Math.floor(48_750 * (1 - EA_TAX_RATE))).toBeGreaterThanOrEqual(46_250);
    expect(Math.floor(48_500 * (1 - EA_TAX_RATE))).toBeLessThan(46_250);
  });

  it('selling at the break-even price is not a loss (net >= 0)', () => {
    for (const cost of [200, 950, 2_000, 13_500, 46_250, 100_000]) {
      const bin = breakEvenListPrice(cost);
      expect(computeTradeProfit(cost, bin).netProfit).toBeGreaterThanOrEqual(0);
    }
  });

  it("never goes under EA's lowest sale price", () => {
    expect(breakEvenListPrice(50)).toBeGreaterThanOrEqual(200);
  });
});

describe('closeTradeRequestSchema', () => {
  it('accepts a sale price alone (soldAt defaults server-side)', () => {
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 12000 }).success).toBe(true);
  });

  it('accepts an explicit soldAt timestamp', () => {
    expect(
      closeTradeRequestSchema.safeParse({ sellPrice: 12000, soldAt: new Date().toISOString() })
        .success,
    ).toBe(true);
  });

  it('rejects fractional or negative prices and unknown keys', () => {
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 12000.5 }).success).toBe(false);
    expect(closeTradeRequestSchema.safeParse({ sellPrice: -1 }).success).toBe(false);
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 12000, netProfit: 5 }).success).toBe(
      false,
    );
  });

  it("enforces EA's 200-coin Buy Now floor, unlike an extension report's 0-coin quick sell", () => {
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 0 }).success).toBe(false);
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 199 }).success).toBe(false);
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 200 }).success).toBe(true);
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 15_000_000 }).success).toBe(true);
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 15_000_001 }).success).toBe(false);
  });
});

function trade(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tradeId: '5001',
    resourceId: 158023,
    assetId: null,
    rating: 91,
    buyPrice: 20000,
    sellPrice: null,
    eaTax: EA_TAX_RATE,
    netProfit: null,
    status: 'bought',
    boughtAt: new Date().toISOString(),
    soldAt: null,
    ...overrides,
  };
}

describe('tradeSchema / tradeIngestSchema: item id and sale source', () => {
  it("accepts a buy with or without the card's item id, bounded like tradeId", () => {
    expect(tradeIngestSchema.safeParse(trade()).success).toBe(true);
    expect(tradeIngestSchema.safeParse(trade({ itemId: '900001' })).success).toBe(true);
    expect(tradeIngestSchema.safeParse(trade({ itemId: 'x'.repeat(64) })).success).toBe(true);
    expect(tradeIngestSchema.safeParse(trade({ itemId: '' })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ itemId: 'x'.repeat(65) })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ itemId: 900001 })).success).toBe(false);
  });

  it('lets the extension say a sale was observed or inferred, never manual', () => {
    const sold = { status: 'sold', sellPrice: 25000, soldAt: new Date().toISOString() };
    expect(tradeIngestSchema.safeParse(trade(sold)).success).toBe(true);
    for (const saleSource of ['observed', 'inferred']) {
      expect(tradeIngestSchema.safeParse(trade({ ...sold, saleSource })).success).toBe(true);
    }
    for (const saleSource of ['manual', null]) {
      expect(tradeIngestSchema.safeParse(trade({ ...sold, saleSource })).success).toBe(false);
    }
  });

  it('carries every source, or null, on the read model', () => {
    for (const saleSource of [...SALE_SOURCES, null]) {
      expect(tradeSchema.safeParse(trade({ saleSource })).success).toBe(true);
    }
    expect(tradeSchema.safeParse(trade({ saleSource: 'guessed' })).success).toBe(false);
  });
});

describe('markTradesSoldRequestSchema', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const parses = (body: unknown) => markTradesSoldRequestSchema.safeParse(body).success;

  it('takes 1 to 100 trade ids, one price and an optional sale time', () => {
    expect(parses({ ids: [id], sellPrice: 15000 })).toBe(true);
    const full = Array(MARK_SOLD_MAX_TRADES).fill(id);
    expect(parses({ ids: full, sellPrice: 15000, soldAt: new Date().toISOString() })).toBe(true);
    expect(parses({ ids: [], sellPrice: 15000 })).toBe(false);
    expect(parses({ ids: [...full, id], sellPrice: 15000 })).toBe(false);
    expect(parses({ ids: ['not-a-uuid'], sellPrice: 15000 })).toBe(false);
  });

  it('applies the same price rules as a single close, and takes nothing else', () => {
    expect(parses({ ids: [id], sellPrice: 199 })).toBe(false);
    expect(parses({ ids: [id], sellPrice: 15_000_001 })).toBe(false);
    expect(parses({ ids: [id], sellPrice: 15000, netProfit: 1 })).toBe(false);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(parses({ ids: [id], sellPrice: 15000, soldAt: future })).toBe(false);
  });
});

describe('openTradesResponseSchema', () => {
  const open = {
    tradeId: '5001',
    itemId: '900001',
    resourceId: 158023,
    rating: null,
    buyPrice: 20000,
    boughtAt: new Date().toISOString(),
  };
  const parses = (body: unknown) => openTradesResponseSchema.safeParse(body).success;

  it('requires the item id on every open trade, and caps the list', () => {
    expect(parses({ items: [open], truncated: false })).toBe(true);
    expect(parses({ items: [{ ...open, itemId: undefined }], truncated: false })).toBe(false);
    expect(parses({ items: Array(OPEN_TRADES_MAX + 1).fill(open), truncated: true })).toBe(false);
    expect(openTradeSchema.safeParse({ ...open, extra: 1 }).success).toBe(false);
    expect(openTradeSchema.safeParse({ ...open, buyPrice: 0 }).success).toBe(false);
  });
});

describe('tradeSellPriceQuerySchema', () => {
  it('reads the resource id from the query string', () => {
    expect(tradeSellPriceQuerySchema.parse({ resourceId: '158023' })).toEqual({
      resourceId: 158023,
    });
    expect(tradeSellPriceQuerySchema.safeParse({ resourceId: 'abc' }).success).toBe(false);
    expect(tradeSellPriceQuerySchema.safeParse({ resourceId: '0' }).success).toBe(false);
    expect(tradeSellPriceQuerySchema.safeParse({}).success).toBe(false);
  });
});
