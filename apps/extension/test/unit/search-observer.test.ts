// Unit coverage for content/search-observer.ts: content's handler for one
// `auctions` message (one search) — the tracked listings, one telemetry `search` event and one batch of ledger rows.

import { describe, expect, it, vi } from 'vitest';

import { createSearchObserver } from '../../src/content/search-observer.js';

import type { TrimmedAuction } from '@sl/shared';

function auction(tradeId: string, resourceId: number, overrides: Partial<TrimmedAuction> = {}): TrimmedAuction {
  return { tradeId, resourceId, assetId: resourceId, rating: 85, buyNow: 1000, startingBid: 150, currentBid: 0, offers: 0, expiresAt: null, seenAt: 1, ...overrides };
}

function observer() {
  const deps = { tracked: new Map<string, TrimmedAuction>(), onDominant: vi.fn(), reportSearch: vi.fn(), record: vi.fn() };
  return { deps, observe: createSearchObserver(deps) };
}

describe('createSearchObserver', () => {
  it('turns one search into one telemetry event and one ledger batch', () => {
    const { deps, observe } = observer();
    const auctions = [auction('a', 7), auction('b', 7), auction('c', 8)];
    observe(auctions);
    expect(deps.onDominant).toHaveBeenCalledWith(7, 85);
    expect(deps.reportSearch).toHaveBeenCalledTimes(1);
    expect(deps.reportSearch).toHaveBeenCalledWith('resource:7', auctions);
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.record).toHaveBeenCalledWith(auctions);
    expect([...deps.tracked.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('reports and records nothing for an empty search', () => {
    const { deps, observe } = observer();
    observe([]);
    observe([]);
    expect(deps.reportSearch).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('reports a mixed search without a dominant card', () => {
    const { deps, observe } = observer();
    observe([auction('a', 1), auction('b', 2), auction('c', 3)]);
    expect(deps.onDominant).not.toHaveBeenCalled();
    expect(deps.reportSearch).toHaveBeenCalledWith('mixed', expect.any(Array));
  });

  it('prunes long-expired listings from the tracked set', () => {
    const { deps, observe } = observer();
    deps.tracked.set('old', auction('old', 1, { expiresAt: Date.now() - 11 * 60_000 }));
    observe([auction('new', 1)]);
    expect(deps.tracked.has('old')).toBe(false);
    expect(deps.tracked.has('new')).toBe(true);
  });
});
