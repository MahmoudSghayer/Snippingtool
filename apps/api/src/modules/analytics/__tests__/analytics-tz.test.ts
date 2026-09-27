// /api/v1/analytics/me/profits?tz= — day buckets in the trader's own time
// zone. The `profits` rollup is per UTC day, so a non-UTC series is derived
// from `trades` at query time; this checks a sale near midnight lands on
// the trader's local day, not the UTC one.

import { trades, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

async function createUser(
  app: FastifyInstance,
  email: string,
): Promise<{ userId: string; token: string }> {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    emailVerifiedAt: new Date(),
  });
  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'user', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

describe('analytics day buckets in the trader time zone (/analytics/me/profits?tz=)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  async function series(token: string, query: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/analytics/me/profits?${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('buckets purchases and sales by the local calendar day of `tz`', async () => {
    const { userId, token } = await createUser(app, 'tz-buckets@example.com');
    const { userId: other } = await createUser(app, 'tz-buckets-other@example.com');
    await app.db.insert(trades).values([
      {
        id: newId(),
        userId,
        tradeId: 'late-sale',
        resourceId: '1',
        buyPrice: 10_000,
        // 21:00 UTC on the 10th is 22:00/23:00 in London but already 06:00
        // on the 11th in Tokyo.
        boughtAt: new Date('2026-09-10T10:00:00.000Z'),
        soldAt: new Date('2026-09-10T21:00:00.000Z'),
        sellPrice: 14_000,
        eaTax: 700,
        netProfit: 3_300,
        status: 'sold',
      },
      {
        id: newId(),
        userId: other,
        tradeId: 'not-mine',
        resourceId: '1',
        buyPrice: 1,
        boughtAt: new Date('2026-09-10T10:00:00.000Z'),
        soldAt: new Date('2026-09-10T21:00:00.000Z'),
        sellPrice: 1_000_000,
        eaTax: 50_000,
        netProfit: 949_999,
        status: 'sold',
      },
    ]);

    const tokyo = await series(
      token,
      'from=2026-09-10&to=2026-09-11&granularity=day&tz=Asia/Tokyo',
    );
    expect(tokyo.statusCode).toBe(200);
    const byDay = Object.fromEntries(
      (tokyo.json().items as { bucket: string }[]).map((p) => [p.bucket, p]),
    );
    expect(byDay['2026-09-10']).toMatchObject({
      coinsSpent: 10_000,
      netProfit: 0,
      tradesClosed: 0,
    });
    expect(byDay['2026-09-11']).toMatchObject({
      coinsSpent: 0,
      coinsEarned: 14_000,
      netProfit: 3_300,
      tradesClosed: 1,
    });

    // "Today" for a Tokyo trader on the 11th: one day, lifetime granularity.
    const today = await series(
      token,
      'from=2026-09-11&to=2026-09-11&granularity=lifetime&tz=Asia/Tokyo',
    );
    expect(today.json().items).toEqual([expect.objectContaining({ netProfit: 3_300 })]);

    // In Los Angeles (UTC-7) both happen on the 10th.
    const la = await series(
      token,
      'from=2026-09-10&to=2026-09-10&granularity=lifetime&tz=America/Los_Angeles',
    );
    expect(la.json().items).toEqual([
      expect.objectContaining({ coinsSpent: 10_000, netProfit: 3_300 }),
    ]);
  });

  it('rejects an unknown zone and a zoned range longer than 90 days', async () => {
    const { token } = await createUser(app, 'tz-bounds@example.com');
    const bad = await series(token, 'from=2026-09-10&to=2026-09-11&tz=Mars/Olympus');
    expect(bad.statusCode).toBe(400);

    const long = await series(token, 'from=2026-01-01&to=2026-09-01&tz=Europe/London');
    expect(long.statusCode).toBe(400);
    expect(long.json().message).toMatch(/90 days/);

    // UTC reads the rollup table, which has no such limit.
    const utcLong = await series(
      token,
      'from=2026-01-01&to=2026-09-01&granularity=lifetime&tz=UTC',
    );
    expect(utcLong.statusCode).toBe(200);
  });

  it('PATCH /users/me only accepts an IANA time zone', async () => {
    const { token } = await createUser(app, 'tz-profile@example.com');
    const patch = (timezone: string) =>
      app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { timezone },
      });
    expect((await patch('Not a zone')).statusCode).toBe(400);
    const ok = await patch('Asia/Tokyo');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().timezone).toBe('Asia/Tokyo');
  });
});
