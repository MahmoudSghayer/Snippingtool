import { describe, expect, it } from 'vitest';

import { meProfitsQuerySchema } from '../../src/schemas/analytics.js';
import { timeZoneSchema } from '../../src/schemas/timezone.js';
import { tradeListQuerySchema } from '../../src/schemas/trades.js';
import { updateProfileRequestSchema } from '../../src/schemas/users.js';

describe('timeZoneSchema', () => {
  it.each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Pacific/Chatham'])(
    'accepts %s',
    (tz) => {
      expect(timeZoneSchema.safeParse(tz).success).toBe(true);
    },
  );

  it.each(['', 'Mars/Olympus_Mons', 'GMT+5; DROP TABLE users', 'x'.repeat(65)])(
    'rejects %j',
    (tz) => {
      expect(timeZoneSchema.safeParse(tz).success).toBe(false);
    },
  );

  it('guards the profile timezone and the profit series tz', () => {
    expect(updateProfileRequestSchema.safeParse({ timezone: 'Not/AZone' }).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ timezone: 'Europe/Paris' }).success).toBe(true);
    expect(
      meProfitsQuerySchema.safeParse({ from: '2026-09-01', to: '2026-09-02', tz: 'Nope/Nope' })
        .success,
    ).toBe(false);
  });
});

describe('tradeListQuerySchema', () => {
  it('defaults to newest first, UTC, no filters', () => {
    expect(tradeListQuerySchema.parse({})).toEqual({ limit: 50, order: 'desc', tz: 'UTC' });
  });

  it('accepts a status, a date range and a timezone', () => {
    expect(
      tradeListQuerySchema.parse({
        status: 'sold',
        from: '2026-09-01',
        to: '2026-09-27',
        tz: 'Europe/London',
        order: 'asc',
      }),
    ).toMatchObject({ status: 'sold', from: '2026-09-01', to: '2026-09-27', order: 'asc' });
  });

  it('rejects an unknown status', () => {
    expect(tradeListQuerySchema.safeParse({ status: 'stolen' }).success).toBe(false);
  });
});
