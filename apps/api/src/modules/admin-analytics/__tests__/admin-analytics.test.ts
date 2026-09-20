// /api/v1/admin/analytics/* — leaderboard ordering over HTTP, CSV report
// streaming + its audit_logs row, and permission denial for a role without
// analytics.read.

import { adminUsers, auditLogs, profits, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

async function createAdmin(app: FastifyInstance, adminRole: 'super_admin' | 'support' | 'analyst', email: string) {
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

async function createUser(app: FastifyInstance, email: string): Promise<string> {
  const id = newId();
  await app.db.insert(users).values({ id, email, passwordHash: 'x', emailVerifiedAt: new Date() });
  return id;
}

describe('admin-analytics module', () => {
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

  it('profits/leaderboard: top-N ordered descending by summed net profit', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'analytics-admin1@example.com');
    const uHigh = await createUser(app, 'lb-high@example.com');
    const uMid = await createUser(app, 'lb-mid@example.com');
    const uLow = await createUser(app, 'lb-low@example.com');

    await app.db.insert(profits).values([
      { id: newId(), userId: uHigh, day: '2024-06-01', netProfit: 900 },
      { id: newId(), userId: uMid, day: '2024-06-01', netProfit: 400 },
      { id: newId(), userId: uLow, day: '2024-06-01', netProfit: -100 },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/profits/leaderboard?from=2024-06-01&to=2024-06-01&limit=3&order=top',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { userId: string }) => i.userId)).toEqual([uHigh, uMid, uLow]);
    expect(body.items[0].rank).toBe(1);
    expect(body.items[0].netProfit).toBe(900);
  });

  it('reports/profits CSV: streams a header + one row per day and writes an analytics.export audit row', async () => {
    const { userId: adminUserId, token } = await createAdmin(app, 'super_admin', 'analytics-admin2@example.com');
    const u = await createUser(app, 'report-user@example.com');
    await app.db.insert(profits).values({ id: newId(), userId: u, day: '2024-06-05', netProfit: 250, coinsSpent: 50, coinsEarned: 300, snipes: 2, successes: 1, tradesClosed: 1 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/reports/profits?from=2024-06-05&to=2024-06-05&format=csv',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('day,net_profit,coins_spent,coins_earned,coins_traded,snipes,successes,trades_closed,active_traders,snipe_success_rate');
    expect(lines[1]).toBe('2024-06-05,250,50,300,350,2,1,1,1,0.5');

    const auditRows = await app.db.query.auditLogs.findMany({
      where: and(eq(auditLogs.action, 'analytics.export'), eq(auditLogs.actorId, adminUserId)),
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.actorType).toBe('admin');
    expect((auditRows[0]!.after as Record<string, unknown>).report).toBe('profits');
    expect((auditRows[0]!.after as Record<string, unknown>).format).toBe('csv');
  });

  it('reports/kpi JSON: format=json returns a buffered items array instead of streaming CSV', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'analytics-admin3@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/reports/kpi?from=2024-06-01&to=2024-06-01&format=json',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].from).toBe('2024-06-01');
  });

  it('a role without analytics.read (support) is forbidden from every admin-analytics route', async () => {
    const { token } = await createAdmin(app, 'support', 'analytics-support@example.com');

    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/overview?from=2024-06-01&to=2024-06-01',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(overview.statusCode).toBe(403);

    const report = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/reports/profits?from=2024-06-01&to=2024-06-01&format=csv',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(report.statusCode).toBe(403);
  });

  it('analyst role (has analytics.read) can read the overview', async () => {
    const { token } = await createAdmin(app, 'analyst', 'analytics-analyst@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/overview?from=2024-06-01&to=2024-06-01',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('unauthenticated requests are rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/analytics/overview?from=2024-06-01&to=2024-06-01' });
    expect(res.statusCode).toBe(401);
  });
});
