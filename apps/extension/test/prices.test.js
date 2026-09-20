import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, margin, maxSnipePrice, EA_TAX } from '../src/model/prices.js';

const now = 1_700_000_000_000;
const HOUR = 3600_000;

/** An auction that was last seen `goneBefore` ms before it was due to expire. */
function row(buyNow, { expiresAt = now - HOUR, goneBefore = 0, id = Math.random() } = {}) {
  return {
    tradeId: String(id),
    resourceId: 42,
    buyNow,
    expiresAt,
    firstSeen: expiresAt - 2 * HOUR,
    lastSeen: expiresAt - goneBefore,
    sightings: 3
  };
}

test('empty input yields nothing rather than zeroes', () => {
  const s = summarise([], now);
  assert.equal(s.listings, 0);
  assert.equal(s.floor, null);
  assert.equal(s.sellThrough, null);
});

test('floor and median come from observed buy-now prices', () => {
  const s = summarise([row(1000), row(1200), row(1400), row(5000)], now);
  assert.equal(s.listings, 4);
  assert.equal(s.floor, 1000);
  assert.equal(s.median, 1300);
});

test('sell-through stays null below a usable sample', () => {
  // 4 decided auctions is noise, not a rate.
  const rows = [row(100, { goneBefore: HOUR }), row(100), row(100), row(100)];
  assert.equal(summarise(rows, now).sellThrough, null);
});

test('an auction that vanished well before expiry counts as sold', () => {
  const sold = Array.from({ length: 3 }, (_, i) => row(1000, { goneBefore: HOUR, id: 'a' + i }));
  const expired = Array.from({ length: 3 }, (_, i) => row(1000, { goneBefore: 0, id: 'b' + i }));
  const s = summarise([...sold, ...expired], now);
  assert.equal(s.sold, 3);
  assert.equal(s.expired, 3);
  assert.equal(s.sample, 6);
  assert.equal(s.sellThrough, 0.5);
});

test('an auction still running is not judged either way', () => {
  const live = row(1000, { expiresAt: now + HOUR });
  const s = summarise([live], now);
  assert.equal(s.sold, 0);
  assert.equal(s.expired, 0);
});

test('margin is net of EA tax', () => {
  const s = summarise([row(10_000), row(10_000), row(10_000)], now);
  const m = margin(s, 8000);
  // 10000 sells for 9500 after the 5% cut, so a snipe at 8000 nets 1500.
  assert.equal(m.netAtMedian, 1500);
  assert.equal(EA_TAX, 0.05);
});

test('margin refuses to guess without a median', () => {
  assert.equal(margin(summarise([], now), 8000), null);
});

test('max snipe price is the break-even for a target profit', () => {
  const s = summarise([row(10_000), row(10_000), row(10_000)], now);
  assert.equal(maxSnipePrice(s, 1000), 8500); // 9500 net - 1000 target
  assert.equal(maxSnipePrice(s, 0), 9500);
});

test('expected value is discounted by how often the card actually sells', () => {
  const sold = Array.from({ length: 6 }, (_, i) => row(10_000, { goneBefore: HOUR, id: 'a' + i }));
  const expired = Array.from({ length: 2 }, (_, i) => row(10_000, { goneBefore: 0, id: 'b' + i }));
  const s = summarise([...sold, ...expired], now);
  const m = margin(s, 8000);
  assert.equal(s.sellThrough, 0.75);
  assert.equal(m.expected, Math.round(1500 * 0.75));
});
