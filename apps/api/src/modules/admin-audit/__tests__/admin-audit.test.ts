// GET /api/v1/admin/audit — filtering + UUID validation on actorId/entityId.
//
// Same synthetic-admin pattern as modules/admin-users/__tests__: seed an
// admin_users row directly and mint a valid access token with
// lib/tokens.ts's own signAccessToken, rather than re-driving the full
// admin login + mandatory-2FA flow.

import { adminUsers, auditLogs, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
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
    totpEnabledAt: new Date(),
  });
  await app.db.insert(adminUsers).values({ id: newId(), userId, adminRole, permissions: {} });

  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'admin', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

describe('admin-audit module: filters + UUID validation', () => {
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

  it('lists audit_logs rows and filters by a valid actorId/entityId (both real UUIDs)', async () => {
    const { userId: adminUserId, token } = await createAdmin(
      app,
      'support',
      'audit-support@example.com',
    );
    const entityId = newId();
    const otherEntityId = newId();

    await app.db.insert(auditLogs).values([
      {
        id: newId(),
        actorType: 'admin',
        actorId: adminUserId,
        action: 'subscription.suspend',
        entityType: 'subscription',
        entityId,
      },
      {
        id: newId(),
        actorType: 'admin',
        actorId: adminUserId,
        action: 'subscription.cancel',
        entityType: 'subscription',
        entityId: otherEntityId,
      },
      {
        id: newId(),
        actorType: 'system',
        actorId: null,
        action: 'subscription.suspend',
        entityType: 'subscription',
        entityId,
      },
    ]);

    const byEntity = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit?entityId=${entityId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byEntity.statusCode).toBe(200);
    const byEntityRows = byEntity.json();
    expect(byEntityRows).toHaveLength(2);
    expect(byEntityRows.every((r: { entityId: string }) => r.entityId === entityId)).toBe(true);

    const byActorAndEntity = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit?entityId=${entityId}&actorId=${adminUserId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byActorAndEntity.statusCode).toBe(200);
    expect(byActorAndEntity.json()).toHaveLength(1);
  });

  it('400s VALIDATION_FAILED for a malformed entityId instead of 500ing on a Postgres uuid cast error', async () => {
    const { token } = await createAdmin(app, 'support', 'audit-support-2@example.com');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit?entityId=not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('400s VALIDATION_FAILED for a malformed actorId', async () => {
    const { token } = await createAdmin(app, 'support', 'audit-support-3@example.com');

    const res = await app.inject({
      method: 'GET',
      url: "/api/v1/admin/audit?actorId=' OR '1'='1",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('applies the same entityId validation to the CSV export route', async () => {
    const { token } = await createAdmin(app, 'support', 'audit-support-4@example.com');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit/export.csv?entityId=also-not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('403s a role without audit.read (none currently — analyst/support/billing/super_admin all have it — so this asserts an unauthenticated caller is rejected instead)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/audit' });
    expect(res.statusCode).toBe(401);
  });
});
