// GET /admin/system/health: every probe answers, versions come from the
// same live-install set as the admin Overview, and one probe that hangs
// (what production's TLS-less queue connection did) degrades only its own
// field instead of blanking the page.

import { adminUsers, extensionInstalls, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

async function createAnalyst(app: FastifyInstance): Promise<string> {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email: 'system-analyst@example.com',
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

describe('admin-system module: GET /admin/system/health', () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports every probe, with extension versions from live extension_installs', async () => {
    const token = await createAnalyst(app);
    const stale = new Date(Date.now() - 60 * 86_400_000);
    await app.db.insert(extensionInstalls).values([
      { id: newId(), installId: 'a', version: '0.1.0.202610180706', browser: 'chrome' },
      { id: newId(), installId: 'b', version: '0.1.0.202610180706', browser: 'edge' },
      { id: newId(), installId: 'c', version: '0.1.0.202610100000', browser: 'chrome' },
      // Not seen for two months: no longer counted.
      {
        id: newId(),
        installId: 'd',
        version: '0.0.9',
        browser: 'chrome',
        firstSeen: stale,
        lastSeen: stale,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system/health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toEqual([]);
    expect(body.db).toEqual({ connected: true });
    expect(body.redis.connectedClients).toBeTruthy();
    expect(body.extensionVersions).toEqual({
      '0.1.0.202610180706': 2,
      '0.1.0.202610100000': 1,
    });
    expect(typeof body.wsOnlineUsers).toBe('number');
    expect(typeof body.errorRateLast5Min).toBe('number');
    // Every src/jobs/*.job.ts queue is probed (through the app's own Redis
    // client, so the deployment's TLS settings apply).
    expect(Object.keys(body.queues)).toEqual(
      expect.arrayContaining(['presence.sweep', 'partitions.maintain', 'analytics.daily']),
    );
    expect(body.queues['presence.sweep']).toEqual({
      waiting: expect.any(Number),
      active: expect.any(Number),
      completed: expect.any(Number),
      failed: expect.any(Number),
      delayed: expect.any(Number),
    });
  });

  it('a probe that never answers degrades only its own field', async () => {
    const token = await createAnalyst(app);
    // The presence count (SCARD) hangs; nothing else uses SCARD.
    vi.spyOn(app.redis, 'scard').mockImplementation(() => new Promise<number>(() => undefined));

    const started = Date.now();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system/health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toEqual(['presence']);
    expect(body.wsOnlineUsers).toBeNull();
    expect(body.db).toEqual({ connected: true });
    expect(body.redis.connectedClients).toBeTruthy();
    expect(Object.keys(body.queues).length).toBeGreaterThan(0);
  });
});
