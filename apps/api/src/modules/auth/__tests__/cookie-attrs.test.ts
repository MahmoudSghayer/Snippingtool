// docs/09-security.md open finding #1 ("Cross-site cookie SameSite for the
// Vercel-hosted dashboard"): `sl_at`/`sl_rt`/`sl_csrf` must honour the
// configurable `COOKIE_SAME_SITE` env var (config/env.ts,
// lib/cookie-options.ts), with `secure` forced true whenever it's 'none'
// (browsers reject SameSite=None cookies without Secure). Two full app
// builds — default ('lax') and cross-site ('none' + COOKIE_SECURE=true) —
// so both cookie-attribute combinations are actually observed on real
// Set-Cookie headers, not just asserted against the resolver function in
// isolation (see config/__tests__/env.test.ts for the env-schema-level
// refusal cases, e.g. 'none' without COOKIE_SECURE).

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { resetEnvCacheForTests } from '../../../config/env.js';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

const device = {
  fingerprint: 'test-fingerprint-cookie-attrs-00001',
  name: 'Test Device',
  browser: 'chrome',
  os: 'linux',
  extensionVersion: '1.0.0',
};

function extractToken(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No token found in email:\n${html}`);
  return decodeURIComponent(match[1]!);
}

async function registerVerifyLogin(
  app: FastifyInstance & { mailer: { sentEmails: Array<{ html: string }> } },
  email: string,
  ip: string,
) {
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: ip,
    payload: { email, password: 'correcthorsebattery12', device, acceptTerms: true },
  });
  expect(registerRes.statusCode).toBe(201);
  const verifyEmail = app.mailer.sentEmails.at(-1)!;
  const token = extractToken(verifyEmail.html);
  const verifyRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    payload: { token },
  });
  expect(verifyRes.statusCode).toBe(200);

  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: ip,
    payload: { email, password: 'correcthorsebattery12', device },
  });
}

/** Logs out with the refresh cookie from `loginRes` and returns the two
 * clear Set-Cookies. A clear is a Set-Cookie with a past expiry, so it must
 * carry the same SameSite/Secure as the set or a cross-site browser drops
 * it (modules/auth/index.ts `clearSessionCookies`). */
async function logoutClears(app: FastifyInstance, loginRes: LightMyRequestResponse, ip: string) {
  const rt = loginRes.cookies.find((c) => c.name === 'sl_rt')!;
  const logoutRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    remoteAddress: ip,
    cookies: { sl_rt: rt.value },
    payload: {},
  });
  expect(logoutRes.statusCode).toBe(200);
  const at = logoutRes.cookies.find((c) => c.name === 'sl_at')!;
  const rtClear = logoutRes.cookies.find((c) => c.name === 'sl_rt')!;
  for (const c of [at, rtClear]) {
    expect(c).toBeTruthy();
    expect(c.value).toBe('');
    expect(c.expires).toBeInstanceOf(Date);
    expect((c.expires as Date).getTime()).toBeLessThan(Date.now());
  }
  return { at, rt: rtClear };
}

describe('cookie attributes — default (COOKIE_SAME_SITE unset -> lax)', () => {
  let app: FastifyInstance & { mailer: { sentEmails: Array<{ html: string }> } };

  beforeAll(async () => {
    delete process.env.COOKIE_SAME_SITE;
    delete process.env.COOKIE_SECURE;
    process.env.NODE_ENV = 'test';
    resetEnvCacheForTests();
    app = (await buildApp({ logger: false })) as typeof app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase((app as unknown as { db: Parameters<typeof resetDatabase>[0] }).db);
    app.mailer.sentEmails.length = 0;
  });

  it('sets sl_at/sl_rt as SameSite=Lax, not Secure (NODE_ENV=test, no COOKIE_SECURE)', async () => {
    const loginRes = await registerVerifyLogin(app, 'lax-user@example.com', '203.0.113.1');
    expect(loginRes.statusCode).toBe(200);

    const at = loginRes.cookies.find((c) => c.name === 'sl_at')!;
    const rt = loginRes.cookies.find((c) => c.name === 'sl_rt')!;
    expect(at.sameSite).toBe('Lax');
    expect(at.secure).toBeFalsy();
    expect(rt.sameSite).toBe('Lax');
    expect(rt.secure).toBeFalsy();

    const csrf = loginRes.cookies.find((c) => c.name === 'sl_csrf')!;
    expect(csrf).toBeTruthy();
    expect(csrf.sameSite).toBe('Lax');
    expect(csrf.secure).toBeFalsy();
  });

  it('logout clears sl_at/sl_rt as SameSite=Lax, not Secure', async () => {
    const loginRes = await registerVerifyLogin(app, 'lax-logout@example.com', '203.0.113.3');
    const { at, rt } = await logoutClears(app, loginRes, '203.0.113.3');
    expect(at.sameSite).toBe('Lax');
    expect(at.secure).toBeFalsy();
    expect(at.path).toBe('/');
    expect(rt.sameSite).toBe('Lax');
    expect(rt.secure).toBeFalsy();
    expect(rt.path).toBe('/api/v1/auth');
  });
});

describe('cookie attributes — cross-site (COOKIE_SAME_SITE=none, COOKIE_SECURE=true)', () => {
  let app: FastifyInstance & { mailer: { sentEmails: Array<{ html: string }> } };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SAME_SITE = 'none';
    process.env.COOKIE_SECURE = 'true';
    resetEnvCacheForTests();
    app = (await buildApp({ logger: false })) as typeof app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.COOKIE_SAME_SITE;
    delete process.env.COOKIE_SECURE;
    resetEnvCacheForTests();
  });

  beforeEach(async () => {
    await resetDatabase((app as unknown as { db: Parameters<typeof resetDatabase>[0] }).db);
    app.mailer.sentEmails.length = 0;
  });

  it('sets sl_at/sl_rt as SameSite=None and Secure', async () => {
    const loginRes = await registerVerifyLogin(app, 'none-user@example.com', '203.0.113.2');
    expect(loginRes.statusCode).toBe(200);

    const at = loginRes.cookies.find((c) => c.name === 'sl_at')!;
    const rt = loginRes.cookies.find((c) => c.name === 'sl_rt')!;
    expect(at.sameSite).toBe('None');
    expect(at.secure).toBe(true);
    expect(rt.sameSite).toBe('None');
    expect(rt.secure).toBe(true);

    const csrf = loginRes.cookies.find((c) => c.name === 'sl_csrf')!;
    expect(csrf).toBeTruthy();
    expect(csrf.sameSite).toBe('None');
    expect(csrf.secure).toBe(true);
  });

  it('logout clears sl_at/sl_rt as SameSite=None and Secure, so a cross-site browser actually drops them', async () => {
    const loginRes = await registerVerifyLogin(app, 'none-logout@example.com', '203.0.113.4');
    const { at, rt } = await logoutClears(app, loginRes, '203.0.113.4');
    expect(at.sameSite).toBe('None');
    expect(at.secure).toBe(true);
    expect(at.path).toBe('/');
    expect(rt.sameSite).toBe('None');
    expect(rt.secure).toBe(true);
    expect(rt.path).toBe('/api/v1/auth');
  });
});
