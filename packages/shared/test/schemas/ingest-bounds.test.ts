import { describe, expect, it } from 'vitest';

import {
  INGEST_MAX_FUTURE_MS,
  INGEST_MAX_PAST_MS,
  closeTradeRequestSchema,
  extensionErrorReportSchema,
  isWithinTradeWindow,
  MAX_COIN_PRICE,
  TIMESTAMP_OUT_OF_WINDOW,
  TRADE_MAX_PAST_MS,
  reportSnipingAttemptsRequestSchema,
  reportTradesRequestSchema,
  snipingAttemptSchema,
  telemetryEventSchema,
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
    expect(TRADE_MAX_PAST_MS).toBe(400 * DAY);
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
    // Tagged, so the API can answer TIMESTAMP_OUT_OF_WINDOW with the item's
    // index instead of a generic validation failure.
    expect(old.error?.issues[0]).toMatchObject({
      code: 'custom',
      params: { code: TIMESTAMP_OUT_OF_WINDOW },
    });
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
    expect(tradeIngestSchema.safeParse(trade({ soldAt: iso(6 * MINUTE) })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ soldAt: iso(-401 * DAY) })).success).toBe(false);
    expect(tradeIngestSchema.safeParse(trade({ extra: 1 })).success).toBe(false);
    expect(reportTradesRequestSchema.safeParse({ trades: [trade({ buyPrice: 0 })] }).success).toBe(
      false,
    );
  });

  // Trades are not partitioned, and a card can sit on the transfer list for
  // weeks: a status update or a dashboard-recorded sale for a trade bought
  // more than 7 days ago must still be accepted. 400 days back, 5 minutes
  // ahead.
  it('trades: timestamps may be up to 400 days old', () => {
    expect(
      tradeIngestSchema.safeParse(
        trade({ boughtAt: iso(-30 * DAY), sellPrice: 2000, soldAt: iso(-8 * DAY) }),
      ).success,
    ).toBe(true);
    expect(tradeIngestSchema.safeParse(trade({ boughtAt: iso(-399 * DAY) })).success).toBe(true);
    expect(tradeIngestSchema.safeParse(trade({ boughtAt: iso(-401 * DAY) })).success).toBe(false);
    expect(
      closeTradeRequestSchema.safeParse({ sellPrice: 1, soldAt: iso(-30 * DAY) }).success,
    ).toBe(true);
    expect(
      closeTradeRequestSchema.safeParse({ sellPrice: 1, soldAt: iso(6 * MINUTE) }).success,
    ).toBe(false);
    expect(isWithinTradeWindow(iso(-30 * DAY))).toBe(true);
    expect(isWithinTradeWindow(iso(6 * MINUTE))).toBe(false);
  });

  it('the trade read model is not bounded: old trades must still serialise', () => {
    expect(tradeSchema.safeParse(trade({ boughtAt: iso(-400 * DAY), buyPrice: 0 })).success).toBe(
      true,
    );
  });
});

describe('extension telemetry and error reports', () => {
  const report = (occurredAt: string) => ({
    deviceId: '6f1c1f5e-3b7a-4d0e-9c2a-6d1b8b0f4a12',
    extensionVersion: '1.0.0',
    errors: [{ message: 'boom', occurredAt }],
  });

  it('accept an occurredAt inside the ingest window', () => {
    expect(telemetryEventSchema.safeParse({ name: 'x', occurredAt: iso(-DAY) }).success).toBe(true);
    expect(extensionErrorReportSchema.safeParse(report(iso(-DAY))).success).toBe(true);
  });

  it('reject one too far ahead or behind, tagged TIMESTAMP_OUT_OF_WINDOW', () => {
    for (const at of [iso(10 * MINUTE), iso(-8 * DAY)]) {
      const event = telemetryEventSchema.safeParse({ name: 'x', occurredAt: at });
      expect(event.success).toBe(false);
      expect(JSON.stringify(event.error!.issues)).toContain(TIMESTAMP_OUT_OF_WINDOW);
      expect(extensionErrorReportSchema.safeParse(report(at)).success).toBe(false);
    }
  });
});
