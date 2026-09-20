// Every non-public route must 401 (not 403, not 500, not 200) when called
// with no credential at all. Public routes (register/login/health/webhook/
// etc.) are excluded deliberately, not because they were skipped.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NIL_LIKE_UUID, buildTestApp, type TestApp } from './helpers.js';

const PROTECTED_ROUTES: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string }> = [
  { method: 'GET', path: '/api/v1/users/me' },
  { method: 'PATCH', path: '/api/v1/users/me' },
  { method: 'DELETE', path: '/api/v1/users/me' },
  { method: 'GET', path: '/api/v1/devices' },
  { method: 'DELETE', path: `/api/v1/devices/${NIL_LIKE_UUID}` },
  { method: 'GET', path: '/api/v1/sessions' },
  { method: 'DELETE', path: `/api/v1/sessions/${NIL_LIKE_UUID}` },
  { method: 'GET', path: '/api/v1/settings' },
  { method: 'PUT', path: '/api/v1/settings' },
  { method: 'GET', path: '/api/v1/notifications' },
  { method: 'GET', path: '/api/v1/filters' },
  { method: 'POST', path: '/api/v1/filters' },
  { method: 'GET', path: '/api/v1/trades' },
  { method: 'POST', path: '/api/v1/trades/batch' },
  { method: 'GET', path: '/api/v1/profits' },
  { method: 'POST', path: '/api/v1/activity/batch' },
  { method: 'POST', path: '/api/v1/sniping/attempts' },
  { method: 'POST', path: '/api/v1/risk-events' },
  { method: 'POST', path: '/api/v1/extension/bootstrap' },
  { method: 'POST', path: '/api/v1/extension/heartbeat' },
  { method: 'POST', path: '/api/v1/auth/logout-all' },
  { method: 'POST', path: '/api/v1/auth/device/register' },
  { method: 'POST', path: '/api/v1/ws/ticket' },
  { method: 'GET', path: '/api/v1/admin/users' },
  { method: 'GET', path: '/api/v1/admin/audit' },
  { method: 'GET', path: '/api/v1/admin/toggles' },
  { method: 'GET', path: '/api/v1/admin/config' },
  { method: 'GET', path: '/api/v1/admin/system/health' },
  { method: 'GET', path: '/api/v1/admin/activity/logins' },
  { method: 'GET', path: '/api/v1/admin/bans' },
  { method: 'GET', path: '/api/v1/admin/flags' },
  { method: 'GET', path: '/api/v1/admin/coupons' },
];

describe('unauthenticated access → 401 on every non-public route', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  for (const route of PROTECTED_ROUTES) {
    it(`401s: ${route.method} ${route.path}`, async () => {
      const res = await app.inject({ method: route.method, url: route.path });
      expect(res.statusCode, `expected 401, got ${res.statusCode}: ${res.body}`).toBe(401);
      const body = res.json();
      expect(['AUTH_TOKEN_INVALID', 'AUTH_TOKEN_EXPIRED', 'AUTH_SESSION_REVOKED']).toContain(body.code);
    });

    it(`401s (not just rejected differently) with a garbage bearer token: ${route.method} ${route.path}`, async () => {
      const res = await app.inject({ method: route.method, url: route.path, headers: { authorization: 'Bearer not-a-real-token' } });
      expect(res.statusCode).toBe(401);
    });
  }

  it('public routes remain reachable with no credential (sanity check the list above is a real allowlist, not just "everything happens to 401")', async () => {
    const health = await app.inject({ method: 'GET', url: '/health/live' });
    expect(health.statusCode).toBe(200);

    const version = await app.inject({ method: 'GET', url: '/api/v1/extension/version' });
    expect(version.statusCode).toBe(200);

    const plans = await app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(plans.statusCode).toBe(200);
  });
});
