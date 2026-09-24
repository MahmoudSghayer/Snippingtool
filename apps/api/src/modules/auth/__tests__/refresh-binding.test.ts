// Refresh-token binding (docs/09-security.md "Session security"): a
// refresh token is scoped to the User-Agent family it was issued to, and
// optionally to an explicitly-presented device fingerprint. Either mismatch
// is treated like refresh-token reuse — the whole session family is
// revoked, not just the one call denied.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';

import type { FastifyInstance } from 'fastify';

const device = {
  fingerprint: 'test-fingerprint-binding-000001',
  name: 'Test Device',
  browser: 'chrome',
  os: 'linux',
  extensionVersion: '1.0.0',
};

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';

let ipCounter = 1;
function nextIp(): string {
  ipCounter += 1;
  return `192.0.2.${ipCounter % 254}`;
}

function extractToken(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No token found in email:\n${html}`);
  return decodeURIComponent(match[1]!);
}

describe('auth module — refresh-token binding', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
  });

  async function registerVerifyAndLogin(email: string, ip: string, userAgent: string) {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      headers: { 'user-agent': userAgent },
      payload: { email, password: 'correcthorsebattery12', device, acceptTerms: true },
    });
    expect(registerRes.statusCode).toBe(201);

    const token = extractToken(app.mailer.sentEmails.at(-1)!.html);
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
      headers: { 'user-agent': userAgent },
      payload: { email, password: 'correcthorsebattery12', device },
    });
    expect(loginRes.statusCode).toBe(200);
    return loginRes.json().refreshToken as string;
  }

  it('refreshes normally when the User-Agent family is unchanged', async () => {
    const ip = nextIp();
    const rt = await registerVerifyAndLogin('ua-stable@example.com', ip, CHROME_UA);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: ip,
      headers: { 'user-agent': CHROME_UA },
      payload: { refreshToken: rt },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects and revokes the whole family when the refresh is presented from a different browser family', async () => {
    const ip = nextIp();
    const rt = await registerVerifyAndLogin('ua-mismatch@example.com', ip, CHROME_UA);

    const stolen = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: ip,
      headers: { 'user-agent': FIREFOX_UA },
      payload: { refreshToken: rt },
    });
    expect(stolen.statusCode).toBe(401);
    expect(stolen.json().code).toBe('AUTH_TOKEN_REUSED');

    // The token is now dead even from the original, correct browser family —
    // the whole family was revoked, not just the mismatched attempt denied.
    const retryFromOriginal = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: ip,
      headers: { 'user-agent': CHROME_UA },
      payload: { refreshToken: rt },
    });
    expect(retryFromOriginal.statusCode).toBe(401);
  });

  it('refresh works with no User-Agent on either side (nothing to contradict)', async () => {
    const ip = nextIp();
    const rt = await registerVerifyAndLogin('ua-absent@example.com', ip, '');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: ip,
      payload: { refreshToken: rt },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects and revokes the whole family when a presented device fingerprint does not match the session device', async () => {
    const ip = nextIp();
    const rt = await registerVerifyAndLogin('device-mismatch@example.com', ip, CHROME_UA);

    const wrongDevice = { ...device, fingerprint: 'a-totally-different-fingerprint-0001' };
    const stolen = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: ip,
      headers: { 'user-agent': CHROME_UA },
      payload: { refreshToken: rt, device: wrongDevice },
    });
    expect(stolen.statusCode).toBe(401);
    expect(stolen.json().code).toBe('AUTH_TOKEN_REUSED');
  });

  it('accepts a refresh that presents the matching device fingerprint', async () => {
    const ip = nextIp();
    const rt = await registerVerifyAndLogin('device-match@example.com', ip, CHROME_UA);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: ip,
      headers: { 'user-agent': CHROME_UA },
      payload: { refreshToken: rt, device },
    });
    expect(res.statusCode).toBe(200);
  });
});
