// CORS: a disallowed Origin must render as a normal AppError-shaped 4xx,
// like every other rejection in this codebase — not a bare 500.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTestApp, type TestApp } from './helpers.js';

describe('CORS (apps/api/src/plugins/cors.ts)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('a disallowed Origin gets a clean 403 AppError body, not a bare 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: 'https://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('FORBIDDEN');
    expect(body.requestId).toBeTruthy();
  });

  it('a request with no Origin header (same-origin/non-browser) is unaffected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(res.statusCode).toBe(200);
  });

  it('the allowed dashboard origin is unaffected', async () => {
    const dashboardOrigin = String(app.config.DASHBOARD_ORIGIN);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/plans',
      headers: { origin: dashboardOrigin },
    });
    expect(res.statusCode).toBe(200);
  });
});
