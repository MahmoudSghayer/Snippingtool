import { describe, expect, it } from 'vitest';

import { EA_TAX, margin, maxSnipePrice, summarise, type AuctionRow } from '../../src/model/prices.js';

const now = 1_700_000_000_000;
const HOUR = 3600_000;

/** An auction that was last seen `goneBefore` ms before it was due to expire. */
function row(
  buyNow: number,
  { expiresAt = now - HOUR, goneBefore = 0, id = Math.random() }: Partial<{ expiresAt: number; goneBefore: number; id: number | string }> = {},
): AuctionRow {
  return {
    tradeId: String(id),
    resourceId: 42,
    buyNow,
    expiresAt,
    firstSeen: expiresAt - 2 * HOUR,
    lastSeen: expiresAt - goneBefore,
    sightings: 3,
  };
}

describe('summarise', () => {
  it('empty input yields nothing rather than zeroes', () => {
    const s = summarise([], now);
    expect(s.listings).toBe(0);
    expect(s.floor).toBeNull();
    expect(s.sellThrough).toBeNull();
  });

  it('floor and median come from observed buy-now prices', () => {
    const s = summarise([row(1000), row(1200), row(1400), row(5000)], now);
    expect(s.listings).toBe(4);
    expect(s.floor).toBe(1000);
    expect(s.median).toBe(1300);
  });

  it('sell-through stays null below a usable sample', () => {
    // 4 decided auctions is noise, not a rate.
    const rows = [row(100, { goneBefore: HOUR }), row(100), row(100), row(100)];
    expect(summarise(rows, now).sellThrough).toBeNull();
  });

  it('an auction that vanished well before expiry counts as sold', () => {
    const sold = Array.from({ length: 3 }, (_, i) => row(1000, { goneBefore: HOUR, id: 'a' + i }));
    const expired = Array.from({ length: 3 }, (_, i) => row(1000, { goneBefore: 0, id: 'b' + i }));
    const s = summarise([...sold, ...expired], now);
    expect(s.sold).toBe(3);
    expect(s.expired).toBe(3);
    expect(s.sample).toBe(6);
    expect(s.sellThrough).toBe(0.5);
  });

  it('an auction still running is not judged either way', () => {
    const live = row(1000, { expiresAt: now + HOUR });
    const s = summarise([live], now);
    expect(s.sold).toBe(0);
    expect(s.expired).toBe(0);
  });
});

describe('margin', () => {
  it('margin is net of EA tax', () => {
    const s = summarise([row(10_000), row(10_000), row(10_000)], now);
    const m = margin(s, 8000);
    // 10000 sells for 9500 after the 5% cut, so a snipe at 8000 nets 1500.
    expect(m?.netAtMedian).toBe(1500);
    expect(EA_TAX).toBe(0.05);
  });

  it('margin refuses to guess without a median', () => {
    expect(margin(summarise([], now), 8000)).toBeNull();
  });

  it('expected value is discounted by how often the card actually sells', () => {
    const sold = Array.from({ length: 6 }, (_, i) => row(10_000, { goneBefore: HOUR, id: 'a' + i }));
    const expired = Array.from({ length: 2 }, (_, i) => row(10_000, { goneBefore: 0, id: 'b' + i }));
    const s = summarise([...sold, ...expired], now);
    const m = margin(s, 8000);
    expect(s.sellThrough).toBe(0.75);
    expect(m?.expected).toBe(Math.round(1500 * 0.75));
  });
});

describe('maxSnipePrice', () => {
  it('max snipe price is the break-even for a target profit', () => {
    const s = summarise([row(10_000), row(10_000), row(10_000)], now);
    expect(maxSnipePrice(s, 1000)).toBe(8500); // 9500 net - 1000 target
    expect(maxSnipePrice(s, 0)).toBe(9500);
  });
});
