// CSRF double-submit (docs/04-auth.md §10): a cookie-session mutation
// without a matching x-csrf-token header 403s; a bearer-authenticated call
// (no cookie involved) is exempt by construction.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bearer,
  createUserSession,
  device,
  nextIp,
  TEST_PASSWORD,
  buildTestApp,
  type TestApp,
} from './helpers.js';

function parseSetCookies(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const cookies: Record<string, string> = {};
  for (const entry of list) {
    const [pair] = entry.split(';');
    const [name, value] = pair!.split('=');
    if (name && value !== undefined) cookies[name.trim()] = value;
  }
  return cookies;
}

describe('CSRF (docs/04-auth.md §10)', () => {
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

  async function loginAsDashboard(email: string, fp: string) {
    const ip = nextIp();
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      payload: { email, password: TEST_PASSWORD, device: device(fp), acceptTerms: true },
    });
    const { userId } = registerRes.json() as { userId: string };
    const mail = app.mailer.sentEmails.at(-1)!;
    const token = mail.html.match(/token=([A-Za-z0-9_-]+)/)![1]!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: ip,
      payload: { token },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password: TEST_PASSWORD, device: device(fp) },
    });
    const cookies = parseSetCookies(loginRes);
    return { userId, cookies, ip };
  }

  it("sets sl_at httpOnly + sl_csrf (not httpOnly, so the dashboard's JS can read it) on login", async () => {
    const { cookies } = await loginAsDashboard(
      'csrf-cookies@example.com',
      'csrf-fp-cookies-00000000000',
    );
    expect(cookies.sl_at).toBeTruthy();
    // @fastify/cookie signs sl_csrf's value (`<value>.<signature>`); the
    // cookie itself still round-trips as a plain string here.
    expect(cookies.sl_csrf).toBeTruthy();
  });

  it('rejects a cookie-session mutation with no x-csrf-token header (403)', async () => {
    const { cookies } = await loginAsDashboard(
      'csrf-missing@example.com',
      'csrf-fp-missing-00000000000',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      cookies: { sl_at: cookies.sl_at!, sl_csrf: cookies.sl_csrf! },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'a-new-password-123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a cookie-session mutation with a wrong/forged x-csrf-token (403)', async () => {
    const { cookies } = await loginAsDashboard(
      'csrf-forged@example.com',
      'csrf-fp-forged-000000000000',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      cookies: { sl_at: cookies.sl_at!, sl_csrf: cookies.sl_csrf! },
      headers: { 'x-csrf-token': 'totally-made-up-token' },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'a-new-password-123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a cookie-session mutation with the correct x-csrf-token (matching the sl_csrf cookie)', async () => {
    const { cookies } = await loginAsDashboard(
      'csrf-valid@example.com',
      'csrf-fp-valid-0000000000000',
    );
    // @fastify/csrf-protection's double-submit check compares the *signed*
    // cookie value against the header — @fastify/cookie signs as
    // `<value>.<hmac>`; per plugins/csrf.ts, verification is a literal
    // double-submit match against the *whole* raw cookie value (no
    // separate token-issuance endpoint exists or is needed) — exactly what
    // apps/dashboard/src/api/client.ts's `readCsrfCookie()` sends: it reads
    // `document.cookie` and echoes the `sl_csrf` value back verbatim, signed
    // segment and all, with no decoding or splitting. Reproduced here the
    // same way.
    const csrfToken = cookies.sl_csrf!;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      cookies: { sl_at: cookies.sl_at!, sl_csrf: cookies.sl_csrf! },
      headers: { 'x-csrf-token': csrfToken },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'a-new-password-123' },
    });
    expect(
      res.statusCode,
      `expected CSRF to pass with the cookie's own plaintext token, got ${res.statusCode}: ${res.body}`,
    ).toBe(200);
  });

  it('a bearer-authenticated mutation needs no CSRF token at all (exempt by construction)', async () => {
    const session = await createUserSession(
      app,
      'csrf-bearer@example.com',
      'csrf-fp-bearer-00000000000',
    );
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: bearer(session.accessToken),
      payload: { timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a GET under a cookie session never requires a CSRF token', async () => {
    const { cookies } = await loginAsDashboard(
      'csrf-get@example.com',
      'csrf-fp-get-00000000000000',
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      cookies: { sl_at: cookies.sl_at! },
    });
    expect(res.statusCode).toBe(200);
  });
});
