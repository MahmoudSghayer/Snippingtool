// Unit coverage for content/search-observer.ts: content's handler for one
// `auctions` message (one search) — the panel counter, the tracked
// listings, one telemetry `search` event and one batch of ledger rows.

import { describe, expect, it, vi } from 'vitest';

import { createSearchObserver } from '../../src/content/search-observer.js';

import type { TrimmedAuction } from '@sl/shared';

function auction(tradeId: string, resourceId: number, overrides: Partial<TrimmedAuction> = {}): TrimmedAuction {
  return { tradeId, resourceId, assetId: resourceId, rating: 85, buyNow: 1000, startingBid: 150, currentBid: 0, offers: 0, expiresAt: null, seenAt: 1, ...overrides };
}

function observer() {
  const deps = { tracked: new Map<string, TrimmedAuction>(), onSearch: vi.fn(), onDominant: vi.fn(), reportSearch: vi.fn(), record: vi.fn() };
  return { deps, observe: createSearchObserver(deps) };
}

describe('createSearchObserver', () => {
  it('turns one search into one count, one telemetry event and one ledger batch', () => {
    const { deps, observe } = observer();
    const auctions = [auction('a', 7), auction('b', 7), auction('c', 8)];
    observe(auctions);
    expect(deps.onSearch).toHaveBeenCalledWith(1);
    expect(deps.onDominant).toHaveBeenCalledWith(7, 85);
    expect(deps.reportSearch).toHaveBeenCalledTimes(1);
    expect(deps.reportSearch).toHaveBeenCalledWith('resource:7', auctions);
    expect(deps.record).toHaveBeenCalledTimes(1);
    expect(deps.record).toHaveBeenCalledWith(auctions);
    expect([...deps.tracked.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('counts an empty search, without reporting or recording anything', () => {
    const { deps, observe } = observer();
    observe([]);
    observe([]);
    expect(deps.onSearch).toHaveBeenLastCalledWith(2);
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

describe('createSearchObserver: the current search (P0 Task 13)', () => {
  it('hands each search’s own listings over once they are tracked, empty searches too', () => {
    const current: string[][] = [];
    const deps = {
      tracked: new Map<string, TrimmedAuction>(),
      onSearch: vi.fn(),
      reportSearch: vi.fn(),
      record: vi.fn(),
      onCurrentSearch: (auctions: TrimmedAuction[]) => {
        // Already tracked by the time the callback runs.
        for (const a of auctions) expect(deps.tracked.has(a.tradeId)).toBe(true);
        current.push(auctions.map((a) => a.tradeId));
      },
    };
    const observe = createSearchObserver(deps);
    observe([auction('a', 1), auction('b', 1)]);
    observe([auction('c', 2)]);
    observe([]);
    expect(current).toEqual([['a', 'b'], ['c'], []]);
    expect([...deps.tracked.keys()]).toEqual(['a', 'b', 'c']);
  });
});
