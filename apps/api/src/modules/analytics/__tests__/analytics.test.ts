// /api/v1/analytics/me/* — every response is scoped to the caller only,
// never another user's data.

import { devices, profits, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';

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

describe('analytics module (/api/v1/analytics/me/*)', () => {
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

  it("overview: scoped to the caller — another user's profits never leak in", async () => {
    const { userId: mine, token } = await createUser(app, 'me-overview-mine@example.com');
    const { userId: other } = await createUser(app, 'me-overview-other@example.com');

    const today = new Date().toISOString().slice(0, 10);
    await app.db.insert(profits).values([
      {
        id: newId(),
        userId: mine,
        day: today,
        netProfit: 300,
        coinsSpent: 100,
        coinsEarned: 500,
        snipes: 4,
        successes: 2,
        tradesClosed: 2,
      },
      {
        id: newId(),
        userId: other,
        day: today,
        netProfit: 99999,
        coinsSpent: 1,
        coinsEarned: 99999,
        snipes: 1,
        successes: 1,
        tradesClosed: 1,
      },
    ]);
    await app.db
      .insert(devices)
      .values({ id: newId(), userId: mine, fingerprintHash: 'fp-1', status: 'active' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/me/overview',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lifetimeNetProfit).toBe(300);
    expect(body.last7d.netProfit).toBe(300);
    expect(body.activeDevices).toBe(1);
    expect(body.snipeSuccessRateLifetime).toBeCloseTo(0.5, 10);
  });

  it("profits: granularity day returns only the caller's own rows", async () => {
    const { userId: mine, token } = await createUser(app, 'me-profits-mine@example.com');
    const { userId: other } = await createUser(app, 'me-profits-other@example.com');

    await app.db.insert(profits).values([
      { id: newId(), userId: mine, day: '2024-05-01', netProfit: 100 },
      { id: newId(), userId: other, day: '2024-05-01', netProfit: 5000 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/me/profits?from=2024-05-01&to=2024-05-01&granularity=day',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].netProfit).toBe(100);
  });

  it('activity: requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/me/activity?from=2024-05-01&to=2024-05-01',
    });
    expect(res.statusCode).toBe(401);
  });
});
