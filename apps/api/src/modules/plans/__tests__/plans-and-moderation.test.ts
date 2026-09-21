// Rounds out coverage for the remaining modules in this agent's ownership
// that the required deliverable-8 scenarios don't already exercise: public
// GET /plans, admin-plans create/archive, admin-bans create/lift (+
// checkBans/session revocation), admin-flags list/review.

import { adminUsers, flags, sessions, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { checkBans } from '../../bans/service.js';
import { createFlag } from '../../flags/service.js';

import type { FastifyInstance } from 'fastify';

async function createAdmin(app: FastifyInstance, email: string) {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    role: 'admin',
    emailVerifiedAt: new Date(),
    totpEnabledAt: new Date(),
  });
  await app.db
    .insert(adminUsers)
    .values({ id: newId(), userId, adminRole: 'super_admin', permissions: {} });
  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'admin', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

async function createVerifiedUser(app: FastifyInstance, email: string): Promise<string> {
  const id = newId();
  await app.db.insert(users).values({
    id,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    emailVerifiedAt: new Date(),
  });
  return id;
}

describe('plans, admin-plans, admin-bans, admin-flags', () => {
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
    await reseedPlans(app.db);
  });

  it('GET /plans lists active plans, ordered by sort_order', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(res.statusCode).toBe(200);
    const codes = res.json().items.map((p: { code: string }) => p.code);
    expect(codes).toEqual(['trial', 'basic', 'pro', 'ultimate', 'lifetime']);
  });

  it('admin-plans: create a lifetime plan, then archive it (never a hard delete)', async () => {
    const { token } = await createAdmin(app, 'plans-admin@example.com');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/plans',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        code: 'founders-2026',
        name: 'Founders 2026',
        priceCents: 4999,
        currency: 'usd',
        interval: 'one_time',
        isLifetime: true,
        deviceLimit: 3,
        features: ['ledger.recorder', 'automation.autobuyer'],
        sortOrder: 10,
        reason: 'limited-time founders offer',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.isLifetime).toBe(true);

    const archiveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/plans/${created.id}/archive`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'offer ended' },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().isActive).toBe(false);

    // Archived, not deleted: still visible to the admin listing.
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/plans',
      headers: { authorization: `Bearer ${token}` },
    });
    const found = listRes.json().items.find((p: { code: string }) => p.code === 'founders-2026');
    expect(found).toBeTruthy();
    expect(found.isActive).toBe(false);

    // No longer on the public listing.
    const publicRes = await app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(publicRes.json().items.some((p: { code: string }) => p.code === 'founders-2026')).toBe(
      false,
    );
  });

  it('admin-bans: an account ban revokes every active session; checkBans reports it; lifting clears it', async () => {
    const { token: adminToken } = await createAdmin(app, 'bans-admin@example.com');
    const targetId = await createVerifiedUser(app, 'ban-target@example.com');

    await app.db.insert(sessions).values({
      id: newId(),
      userId: targetId,
      refreshTokenHash: `hash_${newId()}`,
      familyId: newId(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/bans',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { type: 'account', userId: targetId, reason: 'repeated chargebacks' },
    });
    expect(createRes.statusCode).toBe(201);
    const ban = createRes.json();

    const activeSessions = await app.db.query.sessions.findMany({
      where: and(eq(sessions.userId, targetId), isNull(sessions.revokedAt)),
    });
    expect(activeSessions).toHaveLength(0);

    const check = await checkBans(app.db, { userId: targetId });
    expect(check.banned).toBe(true);
    expect(check.ban!.id).toBe(ban.id);

    const liftRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/bans/${ban.id}/lift`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reason: 'appeal upheld' },
    });
    expect(liftRes.statusCode).toBe(200);
    expect(liftRes.json().liftedAt).toBeTruthy();

    const afterLift = await checkBans(app.db, { userId: targetId });
    expect(afterLift.banned).toBe(false);
  });

  it('admin-flags: lists open flags and marks one reviewed', async () => {
    const { token } = await createAdmin(app, 'flags-admin@example.com');
    const targetId = await createVerifiedUser(app, 'flag-target@example.com');
    const flag = await createFlag(app.db, {
      userId: targetId,
      kind: 'suspicious_ip',
      severity: 'medium',
      evidence: { note: 'test fixture' },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/flags?status=open',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.some((f: { id: string }) => f.id === flag.id)).toBe(true);

    const reviewRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/flags/${flag.id}/review`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'dismissed', reason: 'false positive, confirmed legitimate' },
    });
    expect(reviewRes.statusCode).toBe(200);
    expect(reviewRes.json().status).toBe('dismissed');

    const row = await app.db.query.flags.findFirst({ where: eq(flags.id, flag.id) });
    expect(row!.reviewedBy).toBeTruthy();
  });
});
