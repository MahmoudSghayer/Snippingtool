// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for defect #7 ("Defects found"): calling
// `POST /admin/users/:id/force-logout` on an account an admin already
// `suspend`ed used to be a silent no-op from the notification's point of
// view — `force-logout`'s own `revokeAllUserSessions` call found nothing
// still `revoked_at IS NULL` (suspend's own call already revoked
// everything), so `revokedSessionIds` was `[]`, nothing was pushed over WS,
// and the `200 { ok: true }` response gave no indication anything was
// skipped.
//
// Fixed by having force-logout (1) report `sessionsRevoked` (this call's
// own DB-level revoke count, which can legitimately be 0) and
// `sessionsNotified` in its response body instead of a bare `{ok: true}`,
// and (2) always push a `session.revoked` WS event for every session id
// the target user has ever had, regardless of whether this call's own
// `revokeAllUserSessions` had anything left to revoke — this test proves
// that push actually arrives over a real WebSocket, not just that the
// response looks right.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../../app.js';

import type { FastifyInstance } from 'fastify';

const device = { fingerprint: 'force-logout-ws-fp-0000000001', name: 'Force Logout Test', browser: 'chrome', os: 'linux', extensionVersion: '0.1.0' };

function extractToken(html: string): string {
  return decodeURIComponent(html.match(/token=([A-Za-z0-9_-]+)/)![1]!);
}

async function registerVerifiedUser(app: FastifyInstance, email: string): Promise<{ accessToken: string }> {
  await app.inject({ method: 'POST', url: '/api/v1/auth/register', remoteAddress: '203.0.113.9', payload: { email, password: 'correcthorsebattery12', device } });
  const token = extractToken(app.mailer.sentEmails.at(-1)!.html);
  await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', remoteAddress: '203.0.113.9', payload: { token } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '203.0.113.9', payload: { email, password: 'correcthorsebattery12', device } });
  return login.json() as { accessToken: string };
}

async function createAdmin(app: FastifyInstance, email: string): Promise<{ token: string }> {
  const { adminUsers, users } = await import('@sl/db');
  const { hashSecret } = await import('../../../lib/crypto.js');
  const { newId } = await import('../../../lib/ids.js');
  const { signAccessToken } = await import('../../../lib/tokens.js');

  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    role: 'admin',
    emailVerifiedAt: new Date(),
    totpEnabledAt: new Date(),
  });
  await app.db.insert(adminUsers).values({ id: newId(), userId, adminRole: 'super_admin', permissions: {} });
  const token = await signAccessToken({ sub: userId, sid: newId(), did: null, role: 'admin', plan: null, ver: 0 }, app.config.JWT_PRIVATE_KEY!);
  return { token };
}

describe('force-logout after suspend still notifies the user (defect #7)', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
  });

  it('force-logout after suspend: sessionsRevoked can be 0, but a live WS connection still receives session.revoked', async () => {
    const { users } = await import('@sl/db');
    const { eq } = await import('drizzle-orm');

    const email = 'force-logout-after-suspend@example.com';
    const user = await registerVerifiedUser(app, email);
    const targetRow = await app.db.query.users.findFirst({ where: eq(users.email, email) });
    const targetId = targetRow!.id;

    const admin = await createAdmin(app, 'force-logout-admin@example.com');

    // Open a real, live WS connection for the target user *before* either
    // admin action, so it's still open when force-logout runs.
    const ticketRes = await app.inject({ method: 'POST', url: '/api/v1/ws/ticket', headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(ticketRes.statusCode).toBe(200);
    const { ticket } = ticketRes.json() as { ticket: string };

    const socket = new WebSocket(`${baseUrl}/ws?ticket=${ticket}`);
    const messages: Array<{ type: string; [k: string]: unknown }> = [];
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as { type: string });
    });

    // 1. Suspend — revokes every session in the DB, publishes no WS event of its own.
    const suspendRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/suspend`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { reason: 'defect-8 regression: suspend first' },
    });
    expect(suspendRes.statusCode).toBe(200);

    // 2. Force-logout on the already-suspended account — this is the call under test.
    const forceLogoutRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/force-logout`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { reason: 'defect-8 regression: force-logout after suspend' },
    });
    expect(forceLogoutRes.statusCode).toBe(200);
    const body = forceLogoutRes.json() as { ok: true; sessionsRevoked: number; sessionsNotified: number };
    expect(body.ok).toBe(true);
    // suspend already revoked the only session -> force-logout's own DB-level revoke count is 0 ...
    expect(body.sessionsRevoked).toBe(0);
    // ... but it still knows about (and notifies) the session that exists.
    expect(body.sessionsNotified).toBeGreaterThanOrEqual(1);

    // The live WS connection actually receives the push — the real
    // assertion this defect is about, not just a response-shape check.
    await new Promise((resolve) => setTimeout(resolve, 300)); // pub/sub delivery is async
    const revokedMessages = messages.filter((m) => m.type === 'session.revoked');
    expect(revokedMessages.length).toBeGreaterThanOrEqual(1);
    expect(revokedMessages[0]).toMatchObject({ type: 'session.revoked', reason: 'admin_force_logout' });

    socket.close();
  });

  it('force-logout on an account with no prior suspend still reports a positive sessionsRevoked and notifies', async () => {
    const { users } = await import('@sl/db');
    const { eq } = await import('drizzle-orm');

    const email = 'force-logout-no-suspend@example.com';
    await registerVerifiedUser(app, email);
    const targetRow = await app.db.query.users.findFirst({ where: eq(users.email, email) });
    const targetId = targetRow!.id;

    const admin = await createAdmin(app, 'force-logout-admin-2@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${targetId}/force-logout`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { reason: 'defect-8 regression: no prior suspend' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: true; sessionsRevoked: number; sessionsNotified: number };
    expect(body.sessionsRevoked).toBeGreaterThanOrEqual(1); // the login session created by registerVerifiedUser()
    expect(body.sessionsNotified).toBeGreaterThanOrEqual(1);
  });
});
