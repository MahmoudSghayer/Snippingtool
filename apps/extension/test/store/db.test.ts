import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '../../src/store/db.js';

function auction(overrides: Partial<Parameters<typeof db.recordSightings>[0][number]> = {}) {
  return {
    tradeId: 't1',
    resourceId: 42,
    assetId: 42,
    rating: 88,
    buyNow: 1000,
    startingBid: 500,
    currentBid: 500,
    offers: 0,
    expiresAt: Date.now() + 60_000,
    seenAt: Date.now(),
    ...overrides,
  };
}

describe('store/db', () => {
  beforeEach(async () => {
    await db._resetForTests();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('ledger');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('inserts a new auction and reports it in counts()', async () => {
    const result = await db.recordSightings([auction()]);
    expect(result).toEqual({ inserted: 1, updated: 0 });
    const c = await db.counts();
    expect(c.auctions).toBe(1);
    expect(c.playersLast24h).toBe(1);
  });

  it('updates an existing auction instead of duplicating it', async () => {
    await db.recordSightings([auction({ seenAt: 1000 })]);
    const result = await db.recordSightings([auction({ seenAt: 2000, buyNow: 999999 })]);
    expect(result).toEqual({ inserted: 0, updated: 1 });
    const rows = await db.auctionsForResource(42);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastSeen).toBe(2000);
    // buyNow is never revised once written (sellers cannot edit a live listing).
    expect(rows[0]?.buyNow).toBe(1000);
    expect(rows[0]?.sightings).toBe(2);
  });

  it('filters auctionsForResource by a since window', async () => {
    await db.recordSightings([auction({ tradeId: 'old', seenAt: Date.now() - 1_000_000 })]);
    await db.recordSightings([auction({ tradeId: 'new', seenAt: Date.now() })]);
    const rows = await db.auctionsForResource(42, 60_000);
    expect(rows.map((r) => r.tradeId)).toEqual(['new']);
  });

  it('setMeta/getMeta round-trip', async () => {
    await db.setMeta('lastFilterId', 'abc');
    expect(await db.getMeta('lastFilterId')).toBe('abc');
    expect(await db.getMeta('missing')).toBeNull();
  });
});
