import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SELL_PROBABILITY,
  FLAT_SCORE_THRESHOLD_COINS_PER_HOUR,
  MIN_WINDOWS_FOR_RETIREMENT,
  rankCandidates,
  rotateFilters,
  scoreFilterHistory,
  scoreOpportunity,
  type OpportunityCandidate,
} from '../../src/engine/ranker.js';

import type { PriceSummary } from '../../src/model/prices.js';

function summary(overrides: Partial<PriceSummary> = {}): PriceSummary {
  return {
    listings: 10,
    floor: 900,
    p10: 950,
    median: 1000,
    sellThrough: 0.6,
    sold: 6,
    expired: 4,
    sample: 10,
    tax: 0.05,
    ...overrides,
  };
}

describe('scoreOpportunity', () => {
  it('computes EV as netAtMedian * sellThrough', () => {
    const s = scoreOpportunity(summary({ median: 10_000, sellThrough: 0.75 }), 8000);
    // netAtMedian = 10000*0.95 - 8000 = 1500; ev = round(1500 * 0.75)
    expect(s.netAtMedian).toBe(1500);
    expect(s.ev).toBe(1125);
    expect(s.probabilityOfSale).toBe(0.75);
  });

  it('falls back to the default sell probability when sellThrough is unknown', () => {
    const s = scoreOpportunity(summary({ median: 10_000, sellThrough: null }), 8000);
    expect(s.probabilityOfSale).toBe(DEFAULT_SELL_PROBABILITY);
    expect(s.ev).toBe(Math.round(1500 * DEFAULT_SELL_PROBABILITY));
  });

  it('returns -Infinity EV when there is no median to judge by', () => {
    const s = scoreOpportunity(summary({ median: null }), 8000);
    expect(s.ev).toBe(-Infinity);
  });

  it('rejects a non-positive price', () => {
    const s = scoreOpportunity(summary(), 0);
    expect(s.ev).toBe(-Infinity);
  });
});

describe('rankCandidates', () => {
  const base: OpportunityCandidate = {
    resourceId: 1,
    tradeId: 't1',
    price: 8000,
    summary: summary({ median: 10_000, sellThrough: 0.6 }),
  };

  it('sorts by EV descending', () => {
    const low: OpportunityCandidate = { ...base, tradeId: 'low', price: 9500, summary: summary({ median: 10_000, sellThrough: 0.2 }) };
    const high: OpportunityCandidate = { ...base, tradeId: 'high', price: 7000, summary: summary({ median: 10_000, sellThrough: 0.9 }) };
    const ranked = rankCandidates([low, high]);
    expect(ranked.map((r) => r.tradeId)).toEqual(['high', 'low']);
  });

  it('drops candidates below minEv', () => {
    const negative: OpportunityCandidate = { ...base, tradeId: 'neg', price: 20_000 };
    const ranked = rankCandidates([base, negative], { minEv: 0 });
    expect(ranked.map((r) => r.tradeId)).toEqual(['t1']);
  });

  it('breaks EV ties by lower price', () => {
    // Both score -Infinity (no median to judge by) — a real tie regardless
    // of price — so minEv is relaxed to let them both through and isolate
    // the tie-break itself from the usual EV-based filtering.
    const cheap: OpportunityCandidate = { ...base, tradeId: 'cheap', price: 100, summary: summary({ median: null }) };
    const pricey: OpportunityCandidate = { ...base, tradeId: 'pricey', price: 300, summary: summary({ median: null }) };
    const ranked = rankCandidates([pricey, cheap], { minEv: -Infinity });
    expect(ranked[0]?.ev).toBe(ranked[1]?.ev);
    expect(ranked[0]?.tradeId).toBe('cheap');
  });
});

describe('scoreFilterHistory', () => {
  const HOUR = 3_600_000;
  const now = 1_700_000_000_000;

  it('returns a zero score for no history', () => {
    const s = scoreFilterHistory([], { now });
    expect(s.score).toBe(0);
    expect(s.isFlat).toBe(false);
    expect(s.windowCount).toBe(0);
  });

  it('weights recent windows more heavily than old ones', () => {
    const oldWindow = {
      filterId: 'f1',
      windowStart: new Date(now - 240 * HOUR).toISOString(),
      searches: 10,
      attempts: 2,
      successes: 1,
      coinsSpent: 1000,
      coinsEarned: 1000,
      coinsPerHour: 10, // far in the past, barely paying
    };
    const recentWindow = {
      ...oldWindow,
      windowStart: new Date(now - HOUR).toISOString(),
      coinsPerHour: 1000, // recent, paying well
    };
    const s = scoreFilterHistory([oldWindow, recentWindow], { now, halfLifeHours: 24 });
    // Recent window dominates a 24h half-life average heavily.
    expect(s.score).toBeGreaterThan(500);
  });

  it('is not flat below the minimum window count, even with a low score', () => {
    const windows = Array.from({ length: MIN_WINDOWS_FOR_RETIREMENT - 1 }, (_, i) => ({
      filterId: 'f1',
      windowStart: new Date(now - i * HOUR).toISOString(),
      searches: 5,
      attempts: 0,
      successes: 0,
      coinsSpent: 0,
      coinsEarned: 0,
      coinsPerHour: 0,
    }));
    expect(scoreFilterHistory(windows, { now }).isFlat).toBe(false);
  });

  it('is flat once it has enough windows and a low realised return', () => {
    const windows = Array.from({ length: MIN_WINDOWS_FOR_RETIREMENT }, (_, i) => ({
      filterId: 'f1',
      windowStart: new Date(now - i * HOUR).toISOString(),
      searches: 5,
      attempts: 0,
      successes: 0,
      coinsSpent: 0,
      coinsEarned: 0,
      coinsPerHour: FLAT_SCORE_THRESHOLD_COINS_PER_HOUR - 1,
    }));
    const s = scoreFilterHistory(windows, { now });
    expect(s.isFlat).toBe(true);
  });
});

describe('rotateFilters', () => {
  const filters = [
    { id: 'a', name: 'A', filter: {}, filterHash: 'ha', isActive: true, sortOrder: 0, createdAt: new Date().toISOString() },
    { id: 'b', name: 'B', filter: {}, filterHash: 'hb', isActive: true, sortOrder: 1, createdAt: new Date().toISOString() },
    { id: 'c', name: 'C', filter: {}, filterHash: 'hc', isActive: true, sortOrder: 2, createdAt: new Date().toISOString() },
  ];

  it('keeps a brand-new filter (no score yet) in the pool rather than retiring it', () => {
    const scores = new Map();
    const result = rotateFilters(filters, scores, { maxActive: 5 });
    expect(result.retired).toEqual([]);
    expect(result.active).toHaveLength(3);
  });

  it('retires flat filters and ranks the rest by score', () => {
    const scores = new Map([
      ['a', { filterId: 'a', score: 1000, windowCount: 5, isFlat: false }],
      ['b', { filterId: 'b', score: 5, windowCount: 5, isFlat: true }],
      ['c', { filterId: 'c', score: 500, windowCount: 5, isFlat: false }],
    ]);
    const result = rotateFilters(filters, scores);
    expect(result.retired).toEqual(['b']);
    expect(result.active).toEqual(['a', 'c']);
  });

  it('caps the active set at maxActive', () => {
    const scores = new Map([
      ['a', { filterId: 'a', score: 300, windowCount: 5, isFlat: false }],
      ['b', { filterId: 'b', score: 200, windowCount: 5, isFlat: false }],
      ['c', { filterId: 'c', score: 100, windowCount: 5, isFlat: false }],
    ]);
    const result = rotateFilters(filters, scores, { maxActive: 2 });
    expect(result.active).toEqual(['a', 'b']);
  });
});
