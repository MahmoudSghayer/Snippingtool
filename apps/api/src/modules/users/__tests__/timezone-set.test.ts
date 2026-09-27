// users.timezone defaults to 'UTC', so the value alone can't tell a trader
// who chose UTC from one who never chose. `timezone_set_at` (migration 0036)
// records the explicit choice: stamped by PATCH /users/me and by an admin's
// edit whenever a timezone is sent, never by registration.

import { adminUsers, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

async function createUser(
  app: FastifyInstance,
  email: string,
  role: 'user' | 'admin' = 'user',
): Promise<{ userId: string; token: string }> {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    emailVerifiedAt: new Date(),
    role,
    ...(role === 'admin' ? { totpEnabledAt: new Date() } : {}),
  });
  if (role === 'admin')
    await app.db
      .insert(adminUsers)
      .values({ id: newId(), userId, adminRole: 'super_admin', permissions: {} });
  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role, plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

describe('users.timezone_set_at: an explicit time zone choice', () => {
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

  const me = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });

  it('is null on a new account, and set once the trader saves a zone, even UTC', async () => {
    const { userId, token } = await createUser(app, 'tz-set-self@example.com');
    const before = await me(token);
    expect(before.json()).toMatchObject({ timezone: 'UTC', timezoneSetAt: null });

    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { timezone: 'UTC' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().timezone).toBe('UTC');
    expect(saved.json().timezoneSetAt).toEqual(expect.any(String));

    const row = await app.db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(row?.timezoneSetAt).toBeInstanceOf(Date);
    // GET /users/me and the PATCH share one serialiser. A GET after the
    // PATCH 401s (AUTH_SESSION_REVOKED) in this harness, whose synthetic
    // token has no sessions row, so the PATCH response is checked instead.
    expect(saved.json().timezoneSetAt).toBe(row!.timezoneSetAt!.toISOString());
  });

  it('is not stamped by a PATCH that sends no timezone', async () => {
    const { token } = await createUser(app, 'tz-set-empty@example.com');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().timezoneSetAt).toBeNull();
  });

  it("is set by an admin's timezone edit", async () => {
    const { token } = await createUser(app, 'tz-set-admin@example.com', 'admin');
    const { userId: target } = await createUser(app, 'tz-set-target@example.com');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${target}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { timezone: 'Asia/Tokyo' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      timezone: 'Asia/Tokyo',
      timezoneSetAt: expect.any(String),
    });
  });

  it('is left null by registration, even when a timezone is supplied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: '10.9.8.7',
      payload: {
        email: 'tz-set-register@example.com',
        password: 'correcthorsebattery12',
        timezone: 'Europe/Paris',
        acceptTerms: true,
        device: {
          fingerprint: 'test-fingerprint-tz-set-000000001',
          name: 'Test Device',
          browser: 'chrome',
          os: 'linux',
          extensionVersion: '1.0.0',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const row = await app.db.query.users.findFirst({
      where: eq(users.id, res.json().userId as string),
    });
    expect(row?.timezone).toBe('Europe/Paris');
    expect(row?.timezoneSetAt).toBeNull();
  });
});
