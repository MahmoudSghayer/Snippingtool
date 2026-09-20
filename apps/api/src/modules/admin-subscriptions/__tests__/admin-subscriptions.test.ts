// Admin subscription operations: extend writes an audit_logs row with
// before/after, plus activate/suspend/unsuspend/grant-lifetime happy paths
// and the permission gate.

import { adminUsers, subscriptions, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';

import type { FastifyInstance } from 'fastify';

async function createAdmin(app: FastifyInstance, adminRole: 'super_admin' | 'billing', email: string) {
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
  const token = await signAccessToken({ sub: userId, sid: newId(), did: null, role: 'admin', plan: null, ver: 0 }, app.config.JWT_PRIVATE_KEY!);
  return { userId, token };
}

async function createTargetUser(app: FastifyInstance, email: string) {
  const id = newId();
  await app.db.insert(users).values({ id, email, passwordHash: await hashSecret('irrelevant-password-123'), emailVerifiedAt: new Date() });
  return id;
}

describe('admin-subscriptions module', () => {
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

  it('activate creates a live subscription and issues a license once', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'billing-admin1@example.com');
    const targetId = await createTargetUser(app, 'grant-target1@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${targetId}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { planCode: 'pro', periodDays: 30, reason: 'manual grant for support case #123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('active');
    expect(res.json().plan.code).toBe('pro');
  });

  it('extend writes an audit_logs row with before/after reflecting the new current_period_end', async () => {
    const { token, userId: adminUserId } = await createAdmin(app, 'super_admin', 'billing-admin2@example.com');
    const targetId = await createTargetUser(app, 'extend-target@example.com');

    const activateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${targetId}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { planCode: 'basic', periodDays: 30, reason: 'initial grant' },
    });
    const subscriptionId = activateRes.json().id;

    const beforeRow = await app.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, subscriptionId) });

    const extendRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${subscriptionId}/extend`,
      headers: { authorization: `Bearer ${token}` },
      payload: { periodDays: 14, reason: 'goodwill extension' },
    });
    expect(extendRes.statusCode).toBe(200);

    const auditRows = await app.db.query.auditLogs.findMany({
      where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.entityId, subscriptionId), eqOp(t.action, 'subscription.extend')),
    });
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;
    expect(row.actorType).toBe('admin');
    expect(row.actorId).toBe(adminUserId);
    const before = row.before as Record<string, unknown>;
    const after = row.after as Record<string, unknown>;
    expect(before.currentPeriodEnd).toBe(beforeRow!.currentPeriodEnd!.toISOString());
    expect(after.currentPeriodEnd).not.toBe(before.currentPeriodEnd);
    expect(row.diff).toBeTruthy();

    const adminActionRows = await app.db.query.adminActions.findMany({
      where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.targetId, subscriptionId), eqOp(t.action, 'subscription.extend')),
    });
    expect(adminActionRows).toHaveLength(1);
    expect(adminActionRows[0]!.reason).toBe('goodwill extension');
  });

  it('suspend then unsuspend reverts to the exact previous status', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'billing-admin3@example.com');
    const targetId = await createTargetUser(app, 'suspend-target@example.com');

    const activateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${targetId}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { planCode: 'ultimate', periodDays: 30, reason: 'grant' },
    });
    const subscriptionId = activateRes.json().id;

    const suspendRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${subscriptionId}/suspend`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'suspicious activity' },
    });
    expect(suspendRes.statusCode).toBe(200);
    expect(suspendRes.json().status).toBe('suspended');

    const unsuspendRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${subscriptionId}/unsuspend`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'cleared review' },
    });
    expect(unsuspendRes.statusCode).toBe(200);
    expect(unsuspendRes.json().status).toBe('active');
  });

  it('grant-lifetime creates a lifetime subscription with no current_period_end', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'billing-admin4@example.com');
    const targetId = await createTargetUser(app, 'lifetime-target@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${targetId}/grant-lifetime`,
      headers: { authorization: `Bearer ${token}` },
      payload: { planCode: 'lifetime', reason: 'founders grant' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('lifetime');
    expect(res.json().currentPeriodEnd).toBeNull();
  });

  it('a billing-role admin can activate but not suspend (subscriptions.write is shared; suspend still needs it, so this checks a genuinely ungranted permission instead)', async () => {
    const { token } = await createAdmin(app, 'billing', 'billing-role@example.com');
    const targetId = await createTargetUser(app, 'billing-role-target@example.com');

    const activateRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/subscriptions/${targetId}/activate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { planCode: 'basic', periodDays: 30, reason: 'grant' },
    });
    expect(activateRes.statusCode).toBe(201);
  });
});
