import { describe, expect, it } from 'vitest';

import {
  breakEvenSalePrice,
  isHeavyLoss,
  MIN_SALE_PRICE,
  MIN_START_PRICE,
  parseCoins,
  parseSalePrice,
  priceStep,
  roundToPriceStep,
  stepPrice,
} from '../src/coins.js';
import { MAX_COIN_PRICE } from '../src/schemas/ingest-bounds.js';

describe('parseCoins', () => {
  it.each([
    ['60000', 60_000],
    ['60,000', 60_000],
    ['1,250,000', 1_250_000],
    ['60k', 60_000],
    ['60K', 60_000],
    ['1.2m', 1_200_000],
    ['1.2M', 1_200_000],
    ['2.5k', 2_500],
    ['1.25m', 1_250_000],
    ['  75 k ', 75_000],
    ['1,200k', 1_200_000],
    ['0.5m', 500_000],
    ['.5m', 500_000],
  ])('%s -> %d', (input, coins) => {
    expect(parseCoins(input)).toBe(coins);
  });

  it('never returns a float for a decimal suffix (1.2m is not 1199999.99…)', () => {
    expect(Number.isInteger(parseCoins('1.2m'))).toBe(true);
    expect(parseCoins('4.1k')).toBe(4_100);
  });

  it.each([
    '',
    '   ',
    'abc',
    'k',
    '60kk',
    '60b',
    '-500',
    '1e5',
    '1.2.3',
    '60,00',
    '6,0000',
    ',600',
    '1.2345k', // not whole coins
    '12.5', // not whole coins
  ])('rejects %j', (input) => {
    expect(parseCoins(input)).toBeNull();
  });
});

describe('parseSalePrice', () => {
  it('accepts a price inside the market bounds', () => {
    expect(parseSalePrice('60k')).toEqual({ ok: true, coins: 60_000 });
    expect(parseSalePrice(String(MIN_SALE_PRICE))).toEqual({ ok: true, coins: 200 });
    expect(parseSalePrice('15m')).toEqual({ ok: true, coins: MAX_COIN_PRICE });
  });

  it('rejects anything below 200 coins', () => {
    const result = parseSalePrice('150');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('The lowest sale price is 200 coins.');
  });

  it('rejects anything above 15,000,000 coins', () => {
    const result = parseSalePrice('15,000,001');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('The highest sale price is 15,000,000 coins.');
  });

  it('explains the accepted formats when the input is not a number', () => {
    const result = parseSalePrice('lots');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Enter a price like 60k, 1.2m or 60,000.');
  });
});

describe('breakEvenSalePrice', () => {
  it.each([
    // buy -> break-even on EA's grid (after-tax proceeds cover the buy)
    [250, 300], // 250/0.95 = 263 -> grid 250 nets 237 (short) -> 300 nets 285
    [8_000, 8_500], // 8000/0.95 = 8421 -> grid 8400 nets 7980 (short) -> 8500 nets 8075
    [20_000, 21_250], // 20000/0.95 = 21052 -> grid 21000 nets 19950 (short) -> 21250
    [100_000, 106_000], // 100000/0.95 = 105263 -> grid 105000 nets 99750 (short) -> 106000
  ])('the break-even sale over %i coins is %i', (buy, expected) => {
    expect(breakEvenSalePrice(buy, 0.05)).toBe(expected);
  });

  it('never falls below the 200-coin minimum sale price', () => {
    // 180/0.95 = 189, under EA's floor: the 200-coin minimum nets 190 >= 180.
    expect(breakEvenSalePrice(180, 0.05)).toBe(MIN_SALE_PRICE);
    expect(breakEvenSalePrice(1, 0.05)).toBe(MIN_SALE_PRICE);
  });

  it('always nets at least the buy price, and is the lowest grid price that does', () => {
    for (const buy of [200, 500, 950, 1_000, 3_333, 9_990, 10_000, 49_750, 50_000, 123_456]) {
      const price = breakEvenSalePrice(buy, 0.05);
      expect(Math.floor(price * 0.95)).toBeGreaterThanOrEqual(buy);
      if (price > MIN_SALE_PRICE) {
        // one grid step lower would no longer cover the cost after tax
        expect(Math.floor(stepPrice(price, -1) * 0.95)).toBeLessThan(buy);
      }
    }
  });
});

describe('isHeavyLoss', () => {
  it('is true only when the loss is more than half the buy price', () => {
    expect(isHeavyLoss(10_000, -5_001)).toBe(true);
    expect(isHeavyLoss(10_000, -5_000)).toBe(false);
    expect(isHeavyLoss(10_000, -100)).toBe(false);
    expect(isHeavyLoss(10_000, 2_000)).toBe(false);
  });
});

describe("EA's price steps", () => {
  it.each([
    [150, 50],
    [950, 50],
    [1_000, 100],
    [9_900, 100],
    [10_000, 250],
    [49_750, 250],
    [50_000, 500],
    [99_500, 500],
    [100_000, 1_000],
  ])('the step above %i is %i', (price, step) => {
    expect(priceStep(price)).toBe(step);
  });

  it.each([
    [12_345, 12_250],
    [12_400, 12_500],
    [999, 1_000],
    [1_049, 1_000],
    [10, MIN_START_PRICE],
    [MAX_COIN_PRICE + 5_000, MAX_COIN_PRICE],
  ])('rounds %i to %i on the grid', (price, rounded) => {
    expect(roundToPriceStep(price)).toBe(rounded);
  });

  it.each([
    [10_000, 1, 10_250],
    [10_000, -1, 9_900],
    [1_000, -1, 950],
    [950, 1, 1_000],
    [100_000, -2, 99_000],
    [12_500, 0, 12_500],
    [12_345, 2, 12_750],
    [200, -5, MIN_START_PRICE],
    [MAX_COIN_PRICE, 3, MAX_COIN_PRICE],
  ])('%i moved %i steps is %i', (price, steps, moved) => {
    expect(stepPrice(price, steps)).toBe(moved);
  });
});
