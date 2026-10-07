// F7: /auth/refresh and the single-device /auth/logout are state-changing
// cookie-session mutations, so the browser (cookie) flow must pass the CSRF
// double-submit check. Clients that present the refresh token in the body
// (the extension / API) carry no ambient cookie and stay exempt.
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, device, nextIp, TEST_PASSWORD, type TestApp } from './helpers.js';

function parseSetCookies(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const out: Record<string, string> = {};
  for (const entry of list) {
    const [pair] = entry.split(';');
    const [name, value] = pair!.split('=');
    if (name && value !== undefined) out[name.trim()] = value;
  }
  return out;
}

async function loginWithCookies(app: TestApp, email: string, fp: string) {
  const ip = nextIp();
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD, device: device(fp), acceptTerms: true },
  });
  const mail = app.mailer.sentEmails.at(-1)!;
  const token = (mail.html.match(/token=([A-Za-z0-9_-]+)/) ?? [])[1]!;
  await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', remoteAddress: ip, payload: { token } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD, device: device(fp) },
  });
  const cookies = parseSetCookies(login);
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return { cookies, cookieHeader, refreshToken: (login.json() as { refreshToken: string }).refreshToken };
}

describe('F7 — CSRF on cookie-flow /auth/refresh and /auth/logout', () => {
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

  it('cookie refresh without x-csrf-token is rejected', async () => {
    const { cookieHeader } = await loginWithCookies(app, 'csrf-refresh@example.com', 'fp-csrf-rf-0000001');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    expect(res.statusCode, 'cookie refresh needs CSRF').toBe(403);
  });

  it('cookie refresh with the matching x-csrf-token succeeds', async () => {
    const { cookieHeader, cookies } = await loginWithCookies(app, 'csrf-refresh-ok@example.com', 'fp-csrf-rf-0000002');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: cookieHeader, 'x-csrf-token': cookies.sl_csrf! },
      payload: {},
    });
    expect(res.statusCode, 'valid double-submit passes').toBe(200);
  });

  it('body-token refresh (extension/API, no cookie) stays exempt', async () => {
    const { refreshToken } = await loginWithCookies(app, 'csrf-refresh-body@example.com', 'fp-csrf-rf-0000003');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(res.statusCode, 'explicit body token needs no CSRF').toBe(200);
  });

  it('cookie logout without x-csrf-token is rejected', async () => {
    const { cookieHeader } = await loginWithCookies(app, 'csrf-logout@example.com', 'fp-csrf-lo-0000001');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    expect(res.statusCode, 'cookie logout needs CSRF').toBe(403);
  });
});
