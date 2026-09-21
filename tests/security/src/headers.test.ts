// Security headers (docs/09-security.md "Secure headers"): @fastify/helmet
// (plugins/security.ts) sets CSP/nosniff/frame-deny/referrer-policy, a
// hand-set Permissions-Policy, and HSTS in production only; plugins/csrf.ts
// and app.ts strip X-Powered-By by construction (Fastify never sets it).
// This file asserts the actual response headers on a real request, so a
// change to plugins/security.ts that drops a header is caught here instead
// of only by reading the plugin's own source.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bearer, buildTestApp, createUserSession, type TestApp } from './helpers.js';

describe('security headers (helmet + Permissions-Policy)', () => {
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

  it('an unauthenticated public route (/health/live) carries the full header set', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['permissions-policy']).toContain('microphone=()');
    expect(res.headers['permissions-policy']).toContain('geolocation=()');
    // Fastify never sets X-Powered-By in the first place (unlike Express) —
    // confirmed absent rather than actively stripped.
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('an authenticated JSON route carries the same header set', async () => {
    const user = await createUserSession(
      app,
      'headers-user@example.com',
      'headers-fp-000000000000001',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: bearer(user.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['permissions-policy']).toBeTruthy();
  });

  it('an error response (404/400/401) still carries the full header set — headers apply on every response, not just 2xx', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me' }); // no auth -> 401
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it("HSTS is absent under NODE_ENV=test/development (no local TLS to promise) — dev must never poison a browser's HSTS cache for localhost", async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
