// What a card sells for now, from Nova's own sightings
// (`model/market-price.ts`): the fallback when FUTBIN has no price.

import { describe, expect, it } from 'vitest';

import { MARKET_RECENT_MS, recentMarketPrice } from '../../src/model/market-price.js';

import type { AuctionRow } from '../../src/model/prices.js';

const NOW = 1_800_000_000_000;

function row(buyNow: number, extra: Partial<AuctionRow> = {}): AuctionRow {
  return {
    tradeId: `t-${buyNow}-${Math.random()}`,
    resourceId: 100,
    buyNow,
    expiresAt: NOW + 30 * 60_000,
    firstSeen: NOW - 60_000,
    lastSeen: NOW - 60_000,
    sightings: 1,
    ...extra,
  };
}

describe('recentMarketPrice', () => {
  it('is the second cheapest listing still on the market, not the median', () => {
    // The week's median of these is 2,500; the card sells at about 1,900.
    const rows = [row(1_700), row(1_900), row(2_000), row(2_500), row(3_000), row(4_000), row(5_000)];
    expect(recentMarketPrice(rows, NOW)).toBe(1_900);
  });

  it('leaves out listings not seen in the last half hour, and ones that have ended', () => {
    const rows = [
      row(1_000, { lastSeen: NOW - MARKET_RECENT_MS - 1 }),
      row(1_100, { expiresAt: NOW - 1 }),
      row(1_900),
      row(2_100),
    ];
    expect(recentMarketPrice(rows, NOW)).toBe(2_100);
  });

  it('counts a listing with no known end', () => {
    expect(recentMarketPrice([row(1_800, { expiresAt: null }), row(1_900)], NOW)).toBe(1_900);
  });

  it('is unknown with fewer than two listings to go on', () => {
    expect(recentMarketPrice([], NOW)).toBeNull();
    expect(recentMarketPrice(null, NOW)).toBeNull();
    expect(recentMarketPrice([row(1_900)], NOW)).toBeNull();
    expect(recentMarketPrice([row(1_900), row(0)], NOW)).toBeNull();
  });
});
