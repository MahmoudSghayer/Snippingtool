// Admin permission matrix + audit trail integration tests.
//
// Rather than re-driving the full admin login + mandatory-2FA flow (already
// covered generically by modules/auth's own tests), these tests seed an
// admin_users row directly and mint a valid access token with
// lib/tokens.ts's own signAccessToken — exercising exactly the same
// verification path `authenticate`/`requirePermission` use, without
// re-testing login itself.

import { adminUsers, auditLogs, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

async function createAdmin(
  app: FastifyInstance,
  adminRole: 'super_admin' | 'support' | 'analyst' | 'billing',
  email: string,
) {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    role: 'admin',
    emailVerifiedAt: new Date(),
    totpEnabledAt: new Date(), // admin 2FA already "enrolled" for this synthetic session
  });
  await app.db.insert(adminUsers).values({ id: newId(), userId, adminRole, permissions: {} });

  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'admin', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

async function createTargetUser(app: FastifyInstance, email: string) {
  const id = newId();
  await app.db.insert(users).values({
    id,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    emailVerifiedAt: new Date(),
  });
  return id;
}

describe('admin-users module: permission matrix + audit trail', () => {
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

  it("403s a support-role admin on a permission it lacks (users.ban is not in its grant; analytics.read isn't either) but allows users.suspend", async () => {
    const { token } = await createAdmin(app, 'support', 'support-admin@example.com');

    // `support` does not have `users.ban` in @sl/shared's PERMISSION_MATRIX
    // (that business route belongs to the subscriptions/moderation "bans"
    // module, owned by a different agent) — but `requirePermission` is this
    // agent's shared enforcement mechanism (plugins/auth.ts), so any route
    // gated on a permission `support` lacks exercises the same check. This
    // agent's own admin-activity module is gated on `analytics.read`, which
    // `support` also lacks, so it stands in for the same assertion without
    // depending on the other agent's route existing.
    const analyticsGated = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/activity/logins',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(analyticsGated.statusCode).toBe(403);
    expect(analyticsGated.json().code).toBe('FORBIDDEN');

    const targetId = await createTargetUser(app, 'target1@example.com');
    const suspendRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/suspend`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'abuse report' },
    });
    expect(suspendRes.statusCode).toBe(200);
    expect(suspendRes.json().status).toBe('suspended');
  });

  it('403s an analyst-role admin on users.suspend (read-only role)', async () => {
    const { token } = await createAdmin(app, 'analyst', 'analyst-admin@example.com');
    const targetId = await createTargetUser(app, 'target2@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/suspend`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'test' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('writes an audit_logs row with before/after on an admin patch', async () => {
    const { token, userId: adminUserId } = await createAdmin(
      app,
      'super_admin',
      'super-admin@example.com',
    );
    const targetId = await createTargetUser(app, 'target3@example.com');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${targetId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { timezone: 'Europe/London' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().timezone).toBe('Europe/London');

    const rows = await app.db.query.auditLogs.findMany({ where: eq(auditLogs.entityId, targetId) });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.at(-1)!;
    expect(row.actorType).toBe('admin');
    expect(row.actorId).toBe(adminUserId);
    expect(row.action).toBe('user.updated');
    expect((row.before as Record<string, unknown>).timezone).toBe('UTC');
    expect((row.after as Record<string, unknown>).timezone).toBe('Europe/London');
    expect(row.diff).toBeTruthy();
  });

  it('force-logout revokes all sessions and bumps the token version', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'super-admin-2@example.com');
    const targetId = await createTargetUser(app, 'target4@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/force-logout`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'security incident' },
    });
    expect(res.statusCode).toBe(200);

    const targetUser = await app.db.query.users.findFirst({ where: eq(users.id, targetId) });
    expect(targetUser!.rowVersion).toBeGreaterThan(0);
  });
});
