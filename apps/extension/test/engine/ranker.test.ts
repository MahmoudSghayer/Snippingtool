import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SELL_PROBABILITY,
  rankCandidates,
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

describe('rankCandidates: buyable', () => {
  const candidate: OpportunityCandidate = {
    resourceId: 1,
    tradeId: 'b1',
    price: 8000,
    summary: summary({ median: 10_000, sellThrough: 0.6 }),
  };

  it('drops a listing the adapter said it cannot buy, and keeps one with no flag', () => {
    const ranked = rankCandidates([{ ...candidate, tradeId: 'nope', buyable: false }, candidate, { ...candidate, tradeId: 'yes', buyable: true }]);
    expect(ranked.map((r) => r.tradeId).sort()).toEqual(['b1', 'yes']);
  });
});
