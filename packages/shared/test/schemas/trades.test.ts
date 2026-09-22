import { describe, expect, it } from 'vitest';

import {
  closeTradeRequestSchema,
  computeTradeProfit,
  EA_TAX_RATE,
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
    expect(closeTradeRequestSchema.safeParse({ sellPrice: 1, netProfit: 5 }).success).toBe(false);
  });
});
