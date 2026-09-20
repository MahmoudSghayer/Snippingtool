// Authz matrix: every permission-gated admin route × every admin role that
// does NOT hold the required permission must 403. Built from
// `@sl/shared`'s `PERMISSION_MATRIX` (the single source of truth
// `fastify.requirePermission` itself enforces) crossed with a route table
// hand-curated from every `fastify.requirePermission('<permission>')` call
// across `apps/api/src/modules/admin-*` (grep-verified — see the comment
// below the table). A route's permission check runs in `onRequest`, before
// Fastify's body/params schema validation — so a bogus-but-well-formed
// `:id` (NIL_LIKE_UUID) still hits the permission gate first, exactly the
// same as a real one would.

import { ADMIN_ROLES, PERMISSION_MATRIX, hasPermission, type AdminRole, type Permission } from '@sl/shared';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NIL_LIKE_UUID, bearer, createAdminSession, buildTestApp, type TestApp } from './helpers.js';

interface AdminRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  permission: Permission;
  body?: Record<string, unknown>;
}

// One entry per `fastify.requirePermission(...)` call found by:
//   grep -rn "requirePermission(" apps/api/src/modules/admin-*/index.ts
// (run again if a module gains/loses a route — this table is the thing
// that goes stale, not the assertion methodology).
const ADMIN_ROUTES: AdminRoute[] = [
  { method: 'GET', path: '/api/v1/admin/activity/logins', permission: 'analytics.read' },
  { method: 'GET', path: '/api/v1/admin/analytics/overview', permission: 'analytics.read' },
  { method: 'GET', path: '/api/v1/admin/audit', permission: 'audit.read' },
  { method: 'GET', path: '/api/v1/admin/audit/export.csv', permission: 'audit.read' },
  { method: 'POST', path: `/api/v1/admin/bans`, permission: 'users.ban', body: { type: 'account', userId: NIL_LIKE_UUID, reason: 'x' } },
  { method: 'GET', path: '/api/v1/admin/bans', permission: 'users.ban' },
  { method: 'POST', path: `/api/v1/admin/bans/${NIL_LIKE_UUID}/lift`, permission: 'users.ban', body: { reason: 'x' } },
  { method: 'GET', path: '/api/v1/admin/config', permission: 'system.read' },
  { method: 'PUT', path: '/api/v1/admin/config/some-key', permission: 'config.write', body: { value: 'x' } },
  { method: 'POST', path: '/api/v1/admin/coupons', permission: 'coupons.write', body: { code: 'X', type: 'percent', value: 10, planCodes: ['trial'], maxRedemptions: null, expiresAt: null, reason: 'x' } },
  { method: 'GET', path: '/api/v1/admin/coupons', permission: 'coupons.write' },
  { method: 'PATCH', path: `/api/v1/admin/coupons/${NIL_LIKE_UUID}`, permission: 'coupons.write', body: { reason: 'x' } },
  { method: 'GET', path: '/api/v1/admin/flags', permission: 'users.read' },
  { method: 'POST', path: `/api/v1/admin/flags/${NIL_LIKE_UUID}/review`, permission: 'users.suspend', body: { status: 'dismissed', reason: 'x' } },
  { method: 'POST', path: '/api/v1/admin/plans', permission: 'plans.write', body: {} },
  { method: 'PATCH', path: `/api/v1/admin/plans/${NIL_LIKE_UUID}`, permission: 'plans.write', body: { reason: 'x' } },
  { method: 'GET', path: '/api/v1/admin/system/health', permission: 'system.read' },
  { method: 'GET', path: '/api/v1/admin/toggles', permission: 'system.read' },
  { method: 'PATCH', path: '/api/v1/admin/toggles/some-key', permission: 'feature_toggles.write', body: {} },
  { method: 'GET', path: '/api/v1/admin/users', permission: 'users.read' },
  { method: 'GET', path: `/api/v1/admin/users/${NIL_LIKE_UUID}`, permission: 'users.read' },
  { method: 'PATCH', path: `/api/v1/admin/users/${NIL_LIKE_UUID}`, permission: 'users.write', body: {} },
  { method: 'POST', path: `/api/v1/admin/users/${NIL_LIKE_UUID}/suspend`, permission: 'users.suspend', body: { reason: 'x' } },
  { method: 'POST', path: `/api/v1/admin/users/${NIL_LIKE_UUID}/unsuspend`, permission: 'users.suspend', body: { reason: 'x' } },
  { method: 'POST', path: `/api/v1/admin/users/${NIL_LIKE_UUID}/reset-password`, permission: 'users.reset_password', body: { reason: 'x' } },
  { method: 'POST', path: `/api/v1/admin/users/${NIL_LIKE_UUID}/force-logout`, permission: 'users.force_logout', body: { reason: 'x' } },
  {
    method: 'POST',
    path: `/api/v1/admin/subscriptions/${NIL_LIKE_UUID}/activate`,
    permission: 'subscriptions.write',
    body: { planCode: 'basic', periodDays: 30, reason: 'x' },
  },
];

/** Permissions that exist in `@sl/shared`'s `PERMISSION_MATRIX` but have no
 * enforcement point anywhere in the API yet — checked so the coverage test
 * below documents *why* a permission is missing from `ADMIN_ROUTES` instead
 * of silently skipping it. `subscriptions.read` is declared (billing/
 * analyst/support all list it) but no route currently gates on it — every
 * admin-subscriptions route that reads subscription data is either public
 * data via another gate or not yet built; see docs/09-security.md "Open
 * findings" for the exact fix (gate the read endpoints on it once they
 * exist — owned by the subscriptions/payments module, not this pass). */
const KNOWN_UNENFORCED_PERMISSIONS: readonly Permission[] = [
  'subscriptions.read',
  // Declared, granted to no role in PERMISSION_MATRIX (only 'system.read'
  // is), and gated by no route — reserved for a future system-mutation
  // endpoint. Not a live gap (nothing currently needs it to be enforced),
  // flagged here so it doesn't silently look "covered" by accident either.
  'system.write',
];

describe('authz matrix: admin routes × admin roles', () => {
  let app: TestApp;
  const sessions = new Map<AdminRole, string>();

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
    // One admin session per role, created once — the matrix below only
    // ever reads (never mutates state these sessions depend on), so
    // sharing them across every assertion in this file is safe and much
    // faster than re-enrolling 2FA (a real, non-trivial flow) per case.
    for (const role of ADMIN_ROLES) {
      const session = await createAdminSession(app, role, `matrix-${role}@example.com`, `matrix-fp-${role}-00000000000`);
      sessions.set(role, session.accessToken);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('covers every distinct permission in the matrix table (fails loudly if a route/permission is added without a table entry)', () => {
    const covered = new Set(ADMIN_ROUTES.map((r) => r.permission));
    const allPermissions = new Set(Object.values(PERMISSION_MATRIX).flat());
    for (const permission of allPermissions) {
      if (KNOWN_UNENFORCED_PERMISSIONS.includes(permission)) continue;
      expect(covered.has(permission), `no ADMIN_ROUTES entry exercises permission "${permission}"`).toBe(true);
    }
  });

  for (const route of ADMIN_ROUTES) {
    for (const role of ADMIN_ROLES) {
      const allowed = hasPermission(role, route.permission);
      const label = `${role} (${allowed ? 'has' : 'lacks'} ${route.permission}) → ${route.method} ${route.path}`;

      if (allowed) continue; // positive-path success shapes vary per route (200/201/404/409/…) and are covered by each module's own tests; this matrix asserts the negative case exhaustively.

      it(`403s: ${label}`, async () => {
        const token = sessions.get(role)!;
        const res = await app.inject({
          method: route.method,
          url: route.path,
          headers: bearer(token),
          payload: route.body,
        });
        expect(res.statusCode, `expected 403 for ${label}, got ${res.statusCode}: ${res.body}`).toBe(403);
        expect(res.json().code).toBe('FORBIDDEN');
      });
    }
  }

  it('a non-admin user session 403s on an admin route regardless of permission', async () => {
    const { createUserSession } = await import('./helpers.js');
    const session = await createUserSession(app, 'matrix-plain-user@example.com', 'matrix-fp-plain-000000000000');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(session.accessToken) });
    expect(res.statusCode).toBe(403);
  });
});
