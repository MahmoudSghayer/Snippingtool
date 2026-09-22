// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for defect #6 ("Defects found"): `/admin/analytics/*`
// and `/analytics/me/*` always used the `'day'|'week'|'month'|'lifetime'`
// granularity vocabulary; `/profits` used a separate
// `'daily'|'weekly'|'monthly'|'lifetime'` enum. Fixed by having
// `profitQuerySchema` (packages/shared/src/schemas/trades.ts) share
// `granularitySchema` (schemas/analytics.ts) with every other analytics
// query schema — one canonical vocabulary everywhere, with the legacy
// `'daily'/'weekly'/'monthly'` strings still accepted (and normalised) on
// input for backwards compatibility.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bearer,
  buildTestApp,
  createAdminSession,
  createUserSession,
  type TestApp,
} from '../helpers.js';

describe('granularity vocabulary is unified across /profits and /admin|me analytics (defect #6)', () => {
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

  it('/api/v1/profits accepts the canonical vocabulary (day/week/month/lifetime)', async () => {
    const user = await createUserSession(
      app,
      'gran-canonical@example.com',
      'fp-gran-canonical-001',
    );
    for (const granularity of ['day', 'week', 'month', 'lifetime']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/profits?from=2026-01-01&to=2026-01-31&granularity=${granularity}`,
        headers: bearer(user.accessToken),
      });
      expect(res.statusCode, `granularity=${granularity}`).toBe(200);
      expect(res.json()).toMatchObject({ granularity });
    }
  });

  it('/api/v1/profits still accepts the legacy daily/weekly/monthly aliases (deprecated, normalised to canonical)', async () => {
    const user = await createUserSession(app, 'gran-legacy@example.com', 'fp-gran-legacy-0000001');
    const cases: Array<[string, string]> = [
      ['daily', 'day'],
      ['weekly', 'week'],
      ['monthly', 'month'],
    ];
    for (const [legacy, canonical] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/profits?from=2026-01-01&to=2026-01-31&granularity=${legacy}`,
        headers: bearer(user.accessToken),
      });
      expect(res.statusCode, `granularity=${legacy}`).toBe(200);
      // The response always echoes the canonical value back, never the
      // legacy alias the caller sent — the alias is an input-only affordance.
      expect(res.json()).toMatchObject({ granularity: canonical });
    }
  });

  it('/api/v1/profits rejects a nonsense granularity value the same way it always did', async () => {
    const user = await createUserSession(app, 'gran-invalid@example.com', 'fp-gran-invalid-00001');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/profits?from=2026-01-01&to=2026-01-31&granularity=fortnight',
      headers: bearer(user.accessToken),
    });
    expect(res.statusCode).toBe(400);
  });

  it('/api/v1/profits defaults to the canonical "day" (not the old "daily") when granularity is omitted', async () => {
    const user = await createUserSession(app, 'gran-default@example.com', 'fp-gran-default-00001');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/profits?from=2026-01-01&to=2026-01-31',
      headers: bearer(user.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ granularity: 'day' });
  });

  it('/api/v1/analytics/me/profits already used the canonical vocabulary and still does', async () => {
    const user = await createUserSession(app, 'gran-me@example.com', 'fp-gran-me-000000001');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/me/profits?from=2026-01-01&to=2026-01-31&granularity=week',
      headers: bearer(user.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ granularity: 'week' });
  });

  it('/api/v1/admin/analytics/profits already used the canonical vocabulary and still does', async () => {
    const admin = await createAdminSession(
      app,
      'super_admin',
      'gran-admin@example.com',
      'fp-gran-admin-000001',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/profits?from=2026-01-01&to=2026-01-31&granularity=month',
      headers: bearer(admin.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ granularity: 'month' });
  });
});
