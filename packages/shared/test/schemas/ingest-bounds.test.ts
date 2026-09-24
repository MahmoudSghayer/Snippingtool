import { describe, expect, it } from 'vitest';

import {
  INGEST_MAX_FUTURE_MS,
  INGEST_MAX_PAST_MS,
  MAX_COIN_PRICE,
  reportSnipingAttemptsRequestSchema,
  reportTradesRequestSchema,
  snipingAttemptSchema,
  tradeIngestSchema,
  tradeSchema,
} from '../../src/index.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: '6f1c1f5e-3b7a-4d0e-9c2a-6d1b8b0f4a11',
    resourceId: 1,
    targetPrice: 100,
    listedPrice: 100,
    outcome: 'success',
    latencyMs: 10,
    errorCode: null,
    occurredAt: iso(-MINUTE),
    deviceId: '6f1c1f5e-3b7a-4d0e-9c2a-6d1b8b0f4a12',
    ...overrides,
  };
}

function trade(overrides: Record<string, unknown> = {}) {
  return {
    id: '6f1c1f5e-3b7a-4d0e-9c2a-6d1b8b0f4a13',
    tradeId: 't-1',
    resourceId: 1,
    assetId: null,
    rating: null,
    buyPrice: 1000,
    sellPrice: null,
    eaTax: 0.05,
    netProfit: null,
    status: 'bought',
    boughtAt: iso(-MINUTE),
    soldAt: null,
    ...overrides,
  };
}

describe('ingest bounds', () => {
  it('uses the agreed limits', () => {
    expect(INGEST_MAX_FUTURE_MS).toBe(5 * MINUTE);
    expect(INGEST_MAX_PAST_MS).toBe(7 * DAY);
    expect(MAX_COIN_PRICE).toBe(15_000_000);
  });

  it('sniping: attemptId is optional but must be a uuid', () => {
    const { attemptId: _omit, ...legacy } = attempt();
    expect(snipingAttemptSchema.safeParse(legacy).success).toBe(true);
    expect(snipingAttemptSchema.safeParse(attempt()).success).toBe(true);
    expect(snipingAttemptSchema.safeParse(attempt({ attemptId: 'x' })).success).toBe(false);
  });

  it('sniping: occurredAt must be within 7 days back and 5 minutes ahead', () => {
    expect(snipingAttemptSchema.safeParse(attempt({ occurredAt: iso(4 * MINUTE) })).success).toBe(
      true,
    );
    expect(snipingAttemptSchema.safeParse(attempt({ occurredAt: iso(6 * MINUTE) })).success).toBe(
      false,
    );
    expect(snipingAttemptSchema.safeParse(attempt({ occurredAt: iso(-6 * DAY) })).success).toBe(
      true,
    );
    const old = reportSnipingAttemptsRequestSchema.safeParse({
      attempts: [attempt({ occurredAt: iso(-8 * DAY) })],
    });
    expect(old.success).toBe(false);
    expect(old.error?.issues[0]?.path).toEqual(['attempts', 0, 'occurredAt']);
    expect(old.error?.issues[0]?.message).toMatch(/7 days/);
  });

  it('sniping: prices are integers up to 15,000,000', () => {
    expect(snipingAttemptSchema.safeParse(attempt({ targetPrice: 15_000_000 })).success).toBe(true);
    expect(snipingAttemptSchema.safeParse(attempt({ targetPrice: 15_000_001 })).success).toBe(
      false,
    );
    expect(snipingAttemptSchema.safeParse(attempt({ listedPrice: 3_000_000_000 })).success).toBe(
      false,
    );
  });

  it('trades: buy price 1..15M, sell price 0..15M, timestamps bounded', () => {
    expect(tradeIngestSchema.safeParse(trade()).success).toBe(true);
    expect(tradeIngestSchema.safeParse(trade({ buyPrice: 0 })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ buyPrice: 15_000_001 })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ sellPrice: 0, soldAt: iso(0) })).success).toBe(true);
    expect(tradeIngestSchema.safeParse(trade({ sellPrice: 15_000_001 })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ boughtAt: iso(DAY) })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ soldAt: iso(-8 * DAY) })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ extra: 1 })).success).toBe(false);
    expect(reportTradesRequestSchema.safeParse({ trades: [trade({ buyPrice: 0 })] }).success).toBe(
      false,
    );
  });

  it('the trade read model is not bounded: old trades must still serialise', () => {
    expect(tradeSchema.safeParse(trade({ boughtAt: iso(-400 * DAY), buyPrice: 0 })).success).toBe(
      true,
    );
  });
});
