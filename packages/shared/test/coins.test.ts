import { describe, expect, it } from 'vitest';

import { isHeavyLoss, MIN_SALE_PRICE, parseCoins, parseSalePrice } from '../src/coins.js';
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

describe('isHeavyLoss', () => {
  it('is true only when the loss is more than half the buy price', () => {
    expect(isHeavyLoss(10_000, -5_001)).toBe(true);
    expect(isHeavyLoss(10_000, -5_000)).toBe(false);
    expect(isHeavyLoss(10_000, -100)).toBe(false);
    expect(isHeavyLoss(10_000, 2_000)).toBe(false);
  });
});
