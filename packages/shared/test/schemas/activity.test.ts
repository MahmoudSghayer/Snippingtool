import { describe, expect, it } from 'vitest';

import {
  BOT_PERFORMANCE_DEFAULT_RANGE_MS,
  activityEventSchema,
  activityIngestBatchSchema,
  adminBotPerformanceQuerySchema,
  resolveBotPerformanceRange,
} from '../../src/schemas/activity.js';

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

describe('adminBotPerformanceQuerySchema', () => {
  const ok = (query: unknown) => adminBotPerformanceQuerySchema.safeParse(query).success;

  it('takes no range (the last 24 hours), a range up to 31 days, and a user id', () => {
    expect(ok({})).toBe(true);
    expect(ok({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' })).toBe(true);
    expect(ok({ userId: '11111111-1111-4111-8111-111111111111' })).toBe(true);
  });

  it('refuses a range past 31 days, from after to, a bad user id, or an unknown key', () => {
    expect(ok({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-02T00:00:00.001Z' })).toBe(false);
    expect(ok({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })).toBe(false);
    expect(ok({ from: '2026-10-01' })).toBe(false);
    expect(ok({ userId: 'me' })).toBe(false);
    expect(ok({ limit: 10 })).toBe(false);
  });
});

describe('resolveBotPerformanceRange', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');

  it('defaults to the 24 hours before now, or before `to`', () => {
    expect(resolveBotPerformanceRange({}, now)).toEqual({
      from: new Date(now.getTime() - BOT_PERFORMANCE_DEFAULT_RANGE_MS),
      to: now,
    });
    expect(resolveBotPerformanceRange({ to: '2026-10-10T00:00:00.000Z' }, now)).toEqual({
      from: new Date('2026-10-09T00:00:00.000Z'),
      to: new Date('2026-10-10T00:00:00.000Z'),
    });
  });

  it('keeps an explicit range as given', () => {
    expect(
      resolveBotPerformanceRange(
        { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
        now,
      ),
    ).toEqual({
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-02T00:00:00.000Z'),
    });
  });
});
