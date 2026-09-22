// Mass-assignment defence (docs/09-security.md "Input validation"): every
// request-body schema in this repo is `.strict()` — an unrecognised extra
// key is a 400 (VALIDATION_FAILED), never silently stripped and never
// applied. `packages/shared/test/strictness.test.ts` already covers this
// exhaustively at the schema level (unit tests, no HTTP/DB); this file
// re-checks the highest-value cases end to end through the real running
// app, so a route that (for whatever reason) stops wiring its schema into
// Fastify's validator would be caught here too — plus the specific
// privilege-escalation shape a mass-assignment bug would actually enable:
// a plain user handing `role: "admin"` (or an admin handing a target user
// `role`/`status` outside the dedicated suspend/unsuspend routes) on a
// profile-update call.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bearer,
  buildTestApp,
  createAdminSession,
  createUserSession,
  type TestApp,
} from './helpers.js';

describe('mass assignment: unrecognised extra keys are rejected, never silently applied', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
  });

  it('PATCH /users/me: a plain user cannot smuggle role/status/id/emailVerifiedAt onto their own profile', async () => {
    const user = await createUserSession(
      app,
      'mass-assign-user@example.com',
      'mass-fp-user-0000000000001',
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: bearer(user.accessToken),
      payload: {
        timezone: 'UTC',
        role: 'admin',
        status: 'active',
        id: '00000000-0000-0000-0000-000000000099',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');

    // Confirm nothing was applied even partially — the user is still 'user'.
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(user.accessToken),
    });
    expect(meRes.json().role).toBe('user');
  });

  it('PATCH /admin/users/:id: an admin cannot smuggle role onto a target user via the profile-update route (no such field exists on it by design)', async () => {
    const admin = await createAdminSession(
      app,
      'super_admin',
      'mass-assign-admin@example.com',
      'mass-fp-admin-000000000001',
    );
    const target = await createUserSession(
      app,
      'mass-assign-target@example.com',
      'mass-fp-target-00000000001',
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${target.userId}`,
      headers: bearer(admin.accessToken),
      payload: { timezone: 'UTC', role: 'admin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('POST /filters: an extra top-level key (e.g. userId, trying to write into another account) is rejected', async () => {
    const user = await createUserSession(
      app,
      'mass-assign-filter@example.com',
      'mass-fp-filter-000000000001',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/filters',
      headers: bearer(user.accessToken),
      payload: { name: 'x', filter: {}, userId: '00000000-0000-0000-0000-000000000099' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('POST /activity/batch: an unrecognised top-level key is rejected (fixed — see packages/shared/src/schemas/activity.ts)', async () => {
    const user = await createUserSession(
      app,
      'mass-assign-activity@example.com',
      'mass-fp-activity-00000000001',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/activity/batch',
      headers: bearer(user.accessToken),
      payload: {
        events: [
          {
            type: 'heartbeat',
            occurredAt: new Date().toISOString(),
            metadata: { extensionVersion: '1.0.0' },
          },
        ],
        notARealField: 'sneaky',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('PUT /settings: an unrecognised nested key inside a partial section is rejected, not merged in', async () => {
    const user = await createUserSession(
      app,
      'mass-assign-settings@example.com',
      'mass-fp-settings-0000000001',
    );

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: bearer(user.accessToken),
      payload: { targets: { minProfitPerSnipe: 1000, madeUpField: true } },
    });
    expect(res.statusCode).toBe(400);
  });
});
