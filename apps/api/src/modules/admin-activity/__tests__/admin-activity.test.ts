// /admin/activity/* against rows written the way production writes them:
// through the real login, extension bootstrap/heartbeat/errors, activity
// batch and sniping ingest routes — not hand-inserted rows shaped to fit
// the admin response schemas. Every tab the dashboard's Activity page shows
// must come back 200 and carry what the extension sent.

import { adminUsers, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';
import { grantPlan } from '../../../test/plan-fixtures.js';

import type { FastifyInstance } from 'fastify';

const device = {
  fingerprint: 'admin-activity-fingerprint-0001',
  name: 'Activity Test',
  browser: 'chrome',
  os: 'windows',
  extensionVersion: '0.1.0.202610180706',
};

function extractToken(html: string): string {
  return decodeURIComponent(html.match(/token=([A-Za-z0-9_-]+)/)![1]!);
}

async function createAnalyst(app: FastifyInstance): Promise<string> {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email: 'analyst@example.com',
    passwordHash: await hashSecret('irrelevant-password-123'),
    role: 'admin',
    emailVerifiedAt: new Date(),
    totpEnabledAt: new Date(),
  });
  await app.db
    .insert(adminUsers)
    .values({ id: newId(), userId, adminRole: 'analyst', permissions: {} });
  return signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'admin', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
}

describe('admin-activity module: every tab reads what the extension writes', () => {
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
    app.mailer.sentEmails.length = 0;
  });

  async function seedProductionShapedActivity() {
    const ip = '198.51.100.70';
    const email = 'trader@example.com';
    const password = 'correcthorsebattery12';
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      payload: { email, password, device, acceptTerms: true },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: ip,
      payload: { token: extractToken(app.mailer.sentEmails.at(-1)!.html) },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password, device },
    });
    expect(login.statusCode).toBe(200);
    const accessToken = login.json().accessToken as string;
    const auth = { authorization: `Bearer ${accessToken}` };

    const boot = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/bootstrap',
      headers: auth,
      payload: { device, extensionVersion: device.extensionVersion, buildTarget: 'ledger-auto' },
    });
    expect(boot.statusCode).toBe(200);
    const { userId, deviceId } = boot.json() as { userId: string; deviceId: string };
    await grantPlan(app, userId, 'pro');

    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/heartbeat',
      headers: auth,
      payload: { deviceId, extensionVersion: device.extensionVersion, engineState: 'running' },
    });
    expect(heartbeat.statusCode).toBe(200);

    // The error report the owner quoted: no stack, a context, no code.
    const errors = await app.inject({
      method: 'POST',
      url: '/api/v1/extension/errors',
      headers: auth,
      payload: {
        deviceId,
        extensionVersion: device.extensionVersion,
        errors: [
          { message: 'Browser not supported', context: 'background.uncaught', occurredAt: at(1) },
        ],
      },
    });
    expect(errors.statusCode).toBe(200);

    const batch = await app.inject({
      method: 'POST',
      url: '/api/v1/activity/batch',
      headers: auth,
      payload: {
        events: [
          {
            type: 'search',
            occurredAt: at(5_000),
            metadata: {
              filterHash: 'f-hash-1',
              resourceId: 67_123,
              resultsCount: 3,
              floorPrice: 1200,
            },
          },
          {
            type: 'search',
            occurredAt: at(4_000),
            metadata: { filterHash: 'f-hash-2', resultsCount: 0, floorPrice: null },
          },
          {
            type: 'filter_change',
            occurredAt: at(3_000),
            metadata: { filterId: newId(), action: 'activated' },
          },
          {
            type: 'settings_change',
            occurredAt: at(2_500),
            metadata: { fields: ['bot.riskLevel=moderate'] },
          },
          {
            type: 'heartbeat',
            occurredAt: at(2_000),
            metadata: {
              extensionVersion: device.extensionVersion,
              engineState: 'running',
              bot: {
                windowMs: 120_000,
                searches: 40,
                withResults: 3,
                failed: 1,
                searchMsP50: 310,
                searchMsP90: 640,
                waitingMs: 90_000,
                backoffMs: 0,
                blockedMs: 0,
                breakMs: 0,
                cooldownMs: 4_000,
              },
            },
          },
        ],
      },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toEqual({ accepted: 5, deduped: 0 });

    const snipes = await app.inject({
      method: 'POST',
      url: '/api/v1/sniping/attempts',
      headers: auth,
      payload: {
        attempts: [
          {
            attemptId: newId(),
            resourceId: 67_123,
            tradeId: '423111222333',
            targetPrice: 1100,
            listedPrice: 1000,
            outcome: 'success',
            latencyMs: 180,
            searchMs: 300,
            reactionMs: 40,
            errorCode: null,
            occurredAt: at(1_500),
            deviceId,
          },
          {
            attemptId: newId(),
            resourceId: 67_123,
            targetPrice: 1100,
            listedPrice: null,
            outcome: 'too_slow',
            latencyMs: null,
            errorCode: 'EA_478',
            occurredAt: at(1_000),
            deviceId,
          },
        ],
      },
    });
    expect(snipes.statusCode).toBe(200);

    return { userId, deviceId };
  }

  function todayRange(): string {
    const day = new Date().toISOString().slice(0, 10);
    return `from=${day}T00:00:00.000Z&to=${day}T23:59:59.999Z&limit=100`;
  }

  it('logins, searches, filter changes, snipes and errors each list the rows the extension sent', async () => {
    const { userId, deviceId } = await seedProductionShapedActivity();
    const token = await createAnalyst(app);
    const get = (path: string) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/admin/activity/${path}?${todayRange()}`,
        headers: { authorization: `Bearer ${token}` },
      });

    const logins = await get('logins');
    expect(logins.statusCode).toBe(200);
    expect(logins.json().items).toEqual([
      expect.objectContaining({ userId, deviceId, type: 'login', ip: '198.51.100.70' }),
    ]);

    const searches = await get('searches');
    expect(searches.statusCode).toBe(200);
    expect(searches.json().items).toHaveLength(2);
    expect(searches.json().items[1]).toMatchObject({
      userId,
      filterHash: 'f-hash-1',
      resourceId: '67123',
      resultsCount: 3,
      floorPrice: 1200,
    });

    const filterChanges = await get('filter-changes');
    expect(filterChanges.statusCode).toBe(200);
    expect(filterChanges.json().items).toHaveLength(1);
    expect(filterChanges.json().items[0].metadata.action).toBe('activated');

    const snipes = await get('snipes');
    expect(snipes.statusCode).toBe(200);
    expect(snipes.json().items.map((s: { outcome: string }) => s.outcome)).toEqual([
      'too_slow',
      'success',
    ]);

    const errors = await get('errors');
    expect(errors.statusCode).toBe(200);
    expect(errors.json().items).toHaveLength(1);
    expect(errors.json().items[0]).toMatchObject({
      userId,
      deviceId,
      type: 'error',
      metadata: {
        message: 'Browser not supported',
        context: 'background.uncaught',
        stack: null,
        extensionVersion: device.extensionVersion,
      },
    });
  });

  it('devices and IPs summarise the trader’s device and login address', async () => {
    await seedProductionShapedActivity();
    const token = await createAnalyst(app);
    const headers = { authorization: `Bearer ${token}` };

    const devicesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/activity/devices',
      headers,
    });
    expect(devicesRes.statusCode).toBe(200);
    expect(devicesRes.json()).toMatchObject({
      total: 1,
      byVersion: { [device.extensionVersion]: 1 },
      byOs: { windows: 1 },
    });

    const ips = await app.inject({ method: 'GET', url: '/api/v1/admin/activity/ips', headers });
    expect(ips.statusCode).toBe(200);
    expect(ips.json()).toEqual([expect.objectContaining({ ip: '198.51.100.70' })]);
  });
});
