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

import { resetDatabase } from '@sl/db/test-utils';
import {
  ADMIN_ROLES,
  PERMISSION_MATRIX,
  hasPermission,
  type AdminRole,
  type FeatureKey,
  type Permission,
} from '@sl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NIL_LIKE_UUID,
  bearer,
  createAdminSession,
  createUserSession,
  buildTestApp,
  grantMonthlyPass,
  type TestApp,
} from './helpers.js';

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
  {
    method: 'POST',
    path: `/api/v1/admin/bans`,
    permission: 'users.ban',
    body: { type: 'account', userId: NIL_LIKE_UUID, reason: 'x' },
  },
  { method: 'GET', path: '/api/v1/admin/bans', permission: 'users.ban' },
  {
    method: 'POST',
    path: `/api/v1/admin/bans/${NIL_LIKE_UUID}/lift`,
    permission: 'users.ban',
    body: { reason: 'x' },
  },
  { method: 'GET', path: '/api/v1/admin/config', permission: 'system.read' },
  {
    method: 'PUT',
    path: '/api/v1/admin/config/some-key',
    permission: 'config.write',
    body: { value: 'x' },
  },
  {
    method: 'POST',
    path: '/api/v1/admin/coupons',
    permission: 'coupons.write',
    body: {
      code: 'X',
      type: 'percent',
      value: 10,
      planCodes: ['trial'],
      maxRedemptions: null,
      expiresAt: null,
      reason: 'x',
    },
  },
  { method: 'GET', path: '/api/v1/admin/coupons', permission: 'coupons.write' },
  {
    method: 'PATCH',
    path: `/api/v1/admin/coupons/${NIL_LIKE_UUID}`,
    permission: 'coupons.write',
    body: { reason: 'x' },
  },
  { method: 'GET', path: '/api/v1/admin/flags', permission: 'users.read' },
  {
    method: 'POST',
    path: `/api/v1/admin/flags/${NIL_LIKE_UUID}/review`,
    permission: 'users.suspend',
    body: { status: 'dismissed', reason: 'x' },
  },
  { method: 'POST', path: '/api/v1/admin/plans', permission: 'plans.write', body: {} },
  {
    method: 'PATCH',
    path: `/api/v1/admin/plans/${NIL_LIKE_UUID}`,
    permission: 'plans.write',
    body: { reason: 'x' },
  },
  { method: 'GET', path: '/api/v1/admin/system/health', permission: 'system.read' },
  { method: 'GET', path: '/api/v1/admin/toggles', permission: 'system.read' },
  {
    method: 'PATCH',
    path: '/api/v1/admin/toggles/some-key',
    permission: 'feature_toggles.write',
    body: {},
  },
  { method: 'GET', path: '/api/v1/admin/users', permission: 'users.read' },
  { method: 'GET', path: `/api/v1/admin/users/${NIL_LIKE_UUID}`, permission: 'users.read' },
  {
    method: 'PATCH',
    path: `/api/v1/admin/users/${NIL_LIKE_UUID}`,
    permission: 'users.write',
    body: {},
  },
  {
    method: 'POST',
    path: `/api/v1/admin/users/${NIL_LIKE_UUID}/suspend`,
    permission: 'users.suspend',
    body: { reason: 'x' },
  },
  {
    method: 'POST',
    path: `/api/v1/admin/users/${NIL_LIKE_UUID}/unsuspend`,
    permission: 'users.suspend',
    body: { reason: 'x' },
  },
  {
    method: 'POST',
    path: `/api/v1/admin/users/${NIL_LIKE_UUID}/reset-password`,
    permission: 'users.reset_password',
    body: { reason: 'x' },
  },
  {
    method: 'POST',
    path: `/api/v1/admin/users/${NIL_LIKE_UUID}/force-logout`,
    permission: 'users.force_logout',
    body: { reason: 'x' },
  },
  {
    method: 'POST',
    path: `/api/v1/admin/subscriptions/${NIL_LIKE_UUID}/activate`,
    permission: 'subscriptions.write',
    body: { planCode: 'basic', periodDays: 30, reason: 'x' },
  },
  // API follow-ups pass (docs/07-dashboard.md §11 gaps #2/#5): the list/
  // lookup endpoints that previously left `subscriptions.read` unenforced
  // (see the old `KNOWN_UNENFORCED_PERMISSIONS` comment, now removed below).
  { method: 'GET', path: '/api/v1/admin/subscriptions', permission: 'subscriptions.read' },
  {
    method: 'GET',
    path: `/api/v1/admin/subscriptions/by-user/${NIL_LIKE_UUID}`,
    permission: 'subscriptions.read',
  },
  {
    method: 'GET',
    path: `/api/v1/admin/users/${NIL_LIKE_UUID}/risk-events`,
    permission: 'users.read',
  },
];

/** Permissions that exist in `@sl/shared`'s `PERMISSION_MATRIX` but have no
 * enforcement point anywhere in the API yet — checked so the coverage test
 * below documents *why* a permission is missing from `ADMIN_ROUTES` instead
 * of silently skipping it. (`subscriptions.read` used to be here too — it's
 * now enforced by `GET /admin/subscriptions`/`.../by-user/:userId`, added in
 * the API follow-ups pass, docs/07-dashboard.md §11 gap #2.) */
const KNOWN_UNENFORCED_PERMISSIONS: readonly Permission[] = [
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
      const session = await createAdminSession(
        app,
        role,
        `matrix-${role}@example.com`,
        `matrix-fp-${role}-00000000000`,
      );
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
      expect(
        covered.has(permission),
        `no ADMIN_ROUTES entry exercises permission "${permission}"`,
      ).toBe(true);
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
        expect(
          res.statusCode,
          `expected 403 for ${label}, got ${res.statusCode}: ${res.body}`,
        ).toBe(403);
        expect(res.json().code).toBe('FORBIDDEN');
      });
    }
  }

  it('a non-admin user session 403s on an admin route regardless of permission', async () => {
    const { createUserSession } = await import('./helpers.js');
    const session = await createUserSession(
      app,
      'matrix-plain-user@example.com',
      'matrix-fp-plain-000000000000',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(session.accessToken),
    });
    expect(res.statusCode).toBe(403);
  });
});

// Plan gate (`fastify.requireFeature`, apps/api/src/plugins/auth.ts): one
// read route per gated feature. A signed-in user with no plan gets
// `403 FEATURE_NOT_IN_PLAN` naming the feature; the same user with a
// Monthly pass gets 200. apps/api's own
// src/plugins/__tests__/require-feature.test.ts covers every gated route ×
// basic/expired/trial/Monthly; this is the check against the built app.
const TODAY = new Date().toISOString().slice(0, 10);
const PLAN_GATED_ROUTES: Array<{ path: string; feature: FeatureKey }> = [
  { path: '/api/v1/trades', feature: 'ledger.recorder' },
  { path: `/api/v1/profits?from=${TODAY}&to=${TODAY}`, feature: 'ledger.recorder' },
  { path: '/api/v1/filters', feature: 'assist.filter_rotation' },
  { path: '/api/v1/risk-events', feature: 'assist.risk_meter' },
  { path: '/api/v1/analytics/me/overview', feature: 'dashboard.analytics' },
  { path: '/api/v1/market/movers', feature: 'dashboard.analytics' },
];

describe('authz matrix: plan-gated routes × plan', () => {
  let app: TestApp;
  let noPlan: string;
  let monthly: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
    noPlan = (await createUserSession(app, 'plan-none@example.com', 'plan-fp-none-000000000001'))
      .accessToken;
    const paid = await createUserSession(
      app,
      'plan-monthly@example.com',
      'plan-fp-monthly-0000000001',
    );
    await grantMonthlyPass(app, paid.userId);
    monthly = paid.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  for (const route of PLAN_GATED_ROUTES) {
    it(`403 FEATURE_NOT_IN_PLAN without a plan → GET ${route.path}`, async () => {
      const res = await app.inject({ method: 'GET', url: route.path, headers: bearer(noPlan) });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({
        code: 'FEATURE_NOT_IN_PLAN',
        details: { feature: route.feature },
      });
    });

    it(`200 with a Monthly pass → GET ${route.path}`, async () => {
      const res = await app.inject({ method: 'GET', url: route.path, headers: bearer(monthly) });
      expect(res.statusCode, res.body).toBe(200);
    });
  }
});
