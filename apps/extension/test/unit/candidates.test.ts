// Assist only offers and buys listings from the current search (P0 Task 13,
// item 1): the candidates are built from that search's listings, never from
// every card tracked so far.
import { describe, expect, it } from 'vitest';

import { currentCandidates } from '../../src/content/candidates.js';

import type { PriceSummary } from '../../src/model/prices.js';
import type { TrimmedAuction } from '@sl/shared';

const summary = { median: 2000 } as PriceSummary;
const listing = (tradeId: string, o: Partial<TrimmedAuction> = {}): TrimmedAuction => ({
  tradeId,
  resourceId: 1,
  assetId: 1,
  rating: 85,
  buyNow: 1000,
  startingBid: 0,
  currentBid: 0,
  offers: 0,
  expiresAt: null,
  seenAt: 0,
  ...o,
});

describe('currentCandidates', () => {
  it('turns the current search’s listings into candidates, with their name and rating', () => {
    const out = currentCandidates([listing('a', { name: 'Pedri' })], new Map([[1, summary]]), 0);
    expect(out).toEqual([{ resourceId: 1, tradeId: 'a', price: 1000, summary, name: 'Pedri', rating: 85 }]);
  });

  it('leaves out expired, unbuyable, priceless and unsummarised listings', () => {
    const out = currentCandidates(
      [
        listing('expired', { expiresAt: 5 }),
        listing('unbuyable', { buyable: false }),
        listing('no-bin', { buyNow: 0 }),
        listing('no-summary', { resourceId: 2 }),
        listing('ok'),
      ],
      new Map([[1, summary]]),
      10,
    );
    expect(out.map((c) => c.tradeId)).toEqual(['ok']);
  });
});
