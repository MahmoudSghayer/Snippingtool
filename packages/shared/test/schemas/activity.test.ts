import { describe, expect, it } from 'vitest';

import { activityEventSchema, activityIngestBatchSchema } from '../../src/schemas/activity.js';

const occurredAt = new Date().toISOString();

describe('activityEventSchema', () => {
  it('accepts a search event with only metadata (no listing contents)', () => {
    const result = activityEventSchema.safeParse({
      type: 'search',
      occurredAt,
      metadata: { filterHash: 'abc123', resultsCount: 42, floorPrice: 1000 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a search event missing resultsCount', () => {
    const result = activityEventSchema.safeParse({
      type: 'search',
      occurredAt,
      metadata: { filterHash: 'abc123' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    const result = activityEventSchema.safeParse({
      type: 'market_observation', // raw market data never travels as an activity event
      occurredAt,
      metadata: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('activityIngestBatchSchema', () => {
  it('accepts a mixed batch of event types', () => {
    const result = activityIngestBatchSchema.safeParse({
      events: [
        { type: 'login', occurredAt, metadata: { mfaUsed: true } },
        { type: 'heartbeat', occurredAt, metadata: { extensionVersion: '0.2.0' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty batch', () => {
    expect(activityIngestBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it('rejects a batch over the 500-event cap', () => {
    const events = Array.from({ length: 501 }, () => ({
      type: 'heartbeat' as const,
      occurredAt,
      metadata: { extensionVersion: '0.2.0' },
    }));
    expect(activityIngestBatchSchema.safeParse({ events }).success).toBe(false);
  });
});

describe('heartbeat with the bot pace', () => {
  const pace = {
    windowMs: 120_000,
    searches: 48,
    withResults: 3,
    failed: 1,
    searchMsP50: 182,
    searchMsP90: 260,
    waitingMs: 95_000,
    backoffMs: 0,
    blockedMs: 0,
    breakMs: 0,
    cooldownMs: 10_000,
  };
  const heartbeat = (bot: unknown) =>
    activityEventSchema.safeParse({
      type: 'heartbeat',
      occurredAt,
      metadata: { extensionVersion: '0.2.0', engineState: 'running', bot },
    });

  it('takes the pace: counts and times only', () => {
    expect(heartbeat(pace).success).toBe(true);
    expect(heartbeat({ ...pace, searchMsP50: null, searchMsP90: null }).success).toBe(true);
    // Still valid without one, as before.
    expect(
      activityEventSchema.safeParse({
        type: 'heartbeat',
        occurredAt,
        metadata: { extensionVersion: '0.2.0' },
      }).success,
    ).toBe(true);
  });

  it('refuses anything else in it, a zero window, or values past the bounds', () => {
    expect(heartbeat({ ...pace, listings: [] }).success).toBe(false);
    expect(heartbeat({ ...pace, windowMs: 0 }).success).toBe(false);
    expect(heartbeat({ ...pace, windowMs: 3_600_001 }).success).toBe(false);
    expect(heartbeat({ ...pace, searches: -1 }).success).toBe(false);
    expect(heartbeat({ ...pace, searchMsP50: 1.5 }).success).toBe(false);
  });
});
