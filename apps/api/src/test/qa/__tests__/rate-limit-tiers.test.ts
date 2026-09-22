// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Integration coverage for the per-route-class rate-limit tiers
// (apps/api/src/lib/rate-limit-tiers.ts), previously untested: the
// INGEST_RATE_LIMIT tier (extension batch endpoints, 120/60s), the
// ADMIN_RATE_LIMIT tier (admin mutation routes, 60/60s), and that
// health/liveness probes are exempt from rate limiting entirely
// (HEALTH_EXEMPT_ROUTE_CONFIG) regardless of the global default
// (RATE_LIMIT_GLOBAL_MAX, 300/60s by default).
//
// Each `it` uses its own fixed IP + a single authenticated user's token, so
// the shared `ip:sub` rate-limit key (plugins/rate-limit.ts) is exercised
// consistently across every request within that test without colliding
// with any other test in this file or elsewhere in this run.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ADMIN_RATE_LIMIT, INGEST_RATE_LIMIT } from '../../../lib/rate-limit-tiers.js';
import {
  bearer,
  buildTestApp,
  createAdminSession,
  createUserSession,
  nextIp,
  type TestApp,
} from '../helpers.js';

describe('rate-limit tiers per route class', () => {
  let app: TestApp;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  it(`INGEST_RATE_LIMIT (${INGEST_RATE_LIMIT.max}/${INGEST_RATE_LIMIT.timeWindow}ms): the (max+1)th risk-events batch in the window is rejected with 429`, async () => {
    const user = await createUserSession(app, 'ingest-rl@example.com', 'fp-ingest-rl-000000000001');
    const ip = nextIp();
    const headers = { ...bearer(user.accessToken), 'x-forwarded-for': ip };

    let last200Count = 0;
    let firstRejection:
      { index: number; status: number; retryAfterHeader: string | undefined } | undefined;

    // reportRiskBudgetEventsRequestSchema requires at least one event, with
    // a real deviceId/sessionId (FK-checked at the DB layer) — reuse the
    // ones register/login just created for this user.
    const devicesRes = await app.inject({ method: 'GET', url: '/api/v1/devices', headers });
    const [ownDevice] = devicesRes.json() as Array<{ id: string }>;
    const sessionsRes = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers });
    const [ownSession] = sessionsRes.json() as Array<{ id: string }>;

    const event = {
      deviceId: ownDevice!.id,
      sessionId: ownSession!.id,
      kind: 'actions_per_hour' as const,
      value: 1,
      threshold: 30,
      occurredAt: new Date().toISOString(),
    };

    for (let i = 1; i <= INGEST_RATE_LIMIT.max + 1; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/risk-events',
        headers,
        payload: { events: [event] },
        remoteAddress: ip,
      });
      if (res.statusCode === 200) {
        last200Count++;
      } else if (!firstRejection) {
        firstRejection = {
          index: i,
          status: res.statusCode,
          retryAfterHeader: res.headers['retry-after'] as string | undefined,
        };
      }
    }

    expect(last200Count).toBe(INGEST_RATE_LIMIT.max);
    expect(firstRejection?.index).toBe(INGEST_RATE_LIMIT.max + 1);
    expect(firstRejection?.status).toBe(429);
  }, 20_000);

  it(`ADMIN_RATE_LIMIT (${ADMIN_RATE_LIMIT.max}/${ADMIN_RATE_LIMIT.timeWindow}ms): the (max+1)th admin mutation in the window is rejected with 429`, async () => {
    const admin = await createAdminSession(
      app,
      'super_admin',
      'ingest-rl-admin@example.com',
      'fp-admin-rl-0000000000001',
    );
    const target = await createUserSession(
      app,
      'admin-rl-target@example.com',
      'fp-admin-rl-target-000001',
    );
    const ip = nextIp();
    const headers = { ...bearer(admin.accessToken), 'x-forwarded-for': ip };

    let okCount = 0;
    let firstRejectionIndex: number | undefined;
    let firstRejectionStatus: number | undefined;

    for (let i = 1; i <= ADMIN_RATE_LIMIT.max + 1; i++) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${target.userId}`,
        headers,
        payload: { timezone: 'UTC' },
        remoteAddress: ip,
      });
      if (res.statusCode === 200) {
        okCount++;
      } else if (firstRejectionIndex === undefined) {
        firstRejectionIndex = i;
        firstRejectionStatus = res.statusCode;
      }
    }

    expect(okCount).toBe(ADMIN_RATE_LIMIT.max);
    expect(firstRejectionIndex).toBe(ADMIN_RATE_LIMIT.max + 1);
    expect(firstRejectionStatus).toBe(429);
  }, 20_000);

  it('health probes are exempt from the global default limit (well past RATE_LIMIT_GLOBAL_MAX, still 200)', async () => {
    const ip = nextIp();
    const attempts = app.config.RATE_LIMIT_GLOBAL_MAX + 50;
    let ok = 0;
    for (let i = 0; i < attempts; i++) {
      const res = await app.inject({ method: 'GET', url: '/health/live', remoteAddress: ip });
      if (res.statusCode === 200) ok++;
    }
    expect(ok).toBe(attempts);
  }, 30_000);
});
