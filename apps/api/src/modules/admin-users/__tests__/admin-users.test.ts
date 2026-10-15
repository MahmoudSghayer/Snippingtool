// Admin permission matrix + audit trail integration tests.
//
// Rather than re-driving the full admin login + mandatory-2FA flow (already
// covered generically by modules/auth's own tests), these tests seed an
// admin_users row directly and mint a valid access token with
// lib/tokens.ts's own signAccessToken — exercising exactly the same
// verification path `authenticate`/`requirePermission` use, without
// re-testing login itself.

import { adminActions, adminUsers, auditLogs, users } from '@sl/db';
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

describe('admin-users module: POST /admin/users (create account)', () => {
  let app: FastifyInstance;
  let ipCounter = 10;
  const nextIp = () => `198.51.100.${++ipCounter % 254}`;
  const device = { fingerprint: 'admin-created-fp-000000000000001' };
  const INITIAL_PW = 'Created-by-admin-42';

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
    app.mailer.sentEmails.length = 0;
  });

  function createUser(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it('creates a verified role-user account that can log in with the password the admin set', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'creator@example.com');

    const res = await createUser(token, {
      email: 'New.Member@Example.com',
      password: INITIAL_PW,
      reason: 'customer paid by bank transfer',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      email: 'new.member@example.com',
      role: 'user',
      status: 'active',
      totpEnabled: false,
      adminRole: null,
      permissions: [],
    });
    expect(body.emailVerifiedAt).toEqual(expect.any(String));
    expect(res.body).not.toContain(INITIAL_PW);
    expect(body).not.toHaveProperty('passwordHash');

    const row = await app.db.query.users.findFirst({ where: eq(users.id, body.id) });
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row!.termsVersion).toBeNull();
    expect(app.mailer.sentEmails).toHaveLength(0);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextIp(),
      payload: { email: 'new.member@example.com', password: INITIAL_PW, device },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().status).toBe('ok');
  });

  it('lets support create accounts too (users.create is in its grant)', async () => {
    const { token } = await createAdmin(app, 'support', 'support-creator@example.com');
    const res = await createUser(token, {
      email: 'by-support@example.com',
      password: INITIAL_PW,
      reason: 'onboarding',
    });
    expect(res.statusCode).toBe(201);
  });

  it('with emailVerified: false, leaves the account unverified and sends the verification email', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'creator2@example.com');

    const res = await createUser(token, {
      email: 'unverified@example.com',
      password: INITIAL_PW,
      emailVerified: false,
      reason: 'user will confirm their own address',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().emailVerifiedAt).toBeNull();
    expect(app.mailer.sentEmails.at(-1)?.to).toBe('unverified@example.com');

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextIp(),
      payload: { email: 'unverified@example.com', password: INITIAL_PW, device },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().code).toBe('AUTH_EMAIL_NOT_VERIFIED');
  });

  it('409s when an account with that email already exists (case-insensitive)', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'creator3@example.com');
    await createTargetUser(app, 'taken@example.com');

    const res = await createUser(token, {
      email: 'Taken@Example.com',
      password: INITIAL_PW,
      reason: 'duplicate attempt',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'CONFLICT',
      message: 'An account with this email already exists.',
    });
    const rows = await app.db.query.users.findMany({ where: eq(users.email, 'taken@example.com') });
    expect(rows).toHaveLength(1);
  });

  it('403s an admin whose role lacks users.create, and creates nothing', async () => {
    for (const role of ['analyst', 'billing'] as const) {
      const { token } = await createAdmin(app, role, `${role}-nocreate@example.com`);
      const res = await createUser(token, {
        email: `blocked-${role}@example.com`,
        password: INITIAL_PW,
        reason: 'should not work',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FORBIDDEN');
      const row = await app.db.query.users.findFirst({
        where: eq(users.email, `blocked-${role}@example.com`),
      });
      expect(row).toBeUndefined();
    }
  });

  it('requires the CSRF token on a cookie session', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'creator4@example.com');
    const csrf = app.signCookie('admin-create-csrf-token');
    const payload = { email: 'csrf@example.com', password: INITIAL_PW, reason: 'csrf check' };

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { cookie: `sl_at=${token}; sl_csrf=${encodeURIComponent(csrf)}` },
      payload,
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().message).toBe('Missing CSRF token.');
    expect(
      await app.db.query.users.findFirst({ where: eq(users.email, 'csrf@example.com') }),
    ).toBeUndefined();

    const withToken = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: {
        cookie: `sl_at=${token}; sl_csrf=${encodeURIComponent(csrf)}`,
        'x-csrf-token': csrf,
      },
      payload,
    });
    expect(withToken.statusCode).toBe(201);
  });

  it('writes a user.created audit row and admin_actions row with the reason, never the password', async () => {
    const { token, userId: adminUserId } = await createAdmin(
      app,
      'super_admin',
      'creator5@example.com',
    );

    const res = await createUser(token, {
      email: 'audited@example.com',
      password: INITIAL_PW,
      reason: 'migrated from the old system',
    });
    expect(res.statusCode).toBe(201);
    const newUserId = res.json().id as string;

    const audit = await app.db.query.auditLogs.findMany({
      where: eq(auditLogs.entityId, newUserId),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'admin',
      actorId: adminUserId,
      action: 'user.created',
      entityType: 'user',
      before: null,
      after: { email: 'audited@example.com', role: 'user', status: 'active', emailVerified: true },
    });

    const actions = await app.db.query.adminActions.findMany({
      where: eq(adminActions.targetId, newUserId),
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: 'user.created',
      targetType: 'user',
      reason: 'migrated from the old system',
    });

    const stored = JSON.stringify([audit, actions]);
    expect(stored).not.toContain(INITIAL_PW);
    expect(stored).not.toContain('argon2');
  });

  it('rejects a weak password, a missing reason, and extra fields such as role (400)', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'creator6@example.com');

    const weak = await createUser(token, {
      email: 'weak@example.com',
      password: 'short1',
      reason: 'x',
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.body).not.toContain('short1'); // the rejected password is not echoed back

    const noReason = await createUser(token, {
      email: 'noreason@example.com',
      password: INITIAL_PW,
    });
    expect(noReason.statusCode).toBe(400);

    const withRole = await createUser(token, {
      email: 'sneaky@example.com',
      password: INITIAL_PW,
      reason: 'x',
      role: 'admin',
    });
    expect(withRole.statusCode).toBe(400);
    expect(withRole.json().code).toBe('VALIDATION_FAILED');

    const rows = await app.db.query.users.findMany({ where: eq(users.role, 'user') });
    expect(rows).toHaveLength(0);
  });
});
