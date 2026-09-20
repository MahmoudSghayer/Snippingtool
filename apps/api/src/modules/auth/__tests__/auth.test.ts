// Integration tests for the auth module: register -> verify -> login ->
// refresh -> rotation reuse detection -> logout; lockout; 2FA enrol +
// step-up; device limit; password reset; CSRF on cookie sessions.
//
// Runs against the real local test database + Redis (see
// apps/api/vitest.config.ts / src/config/env.ts's NODE_ENV=test ->
// TEST_DATABASE_URL redirect, and plugins/redis.ts's per-run Redis key
// prefix). Each test gets its own `remoteAddress` so per-IP rate limiting
// in one test never leaks into another.

import { resetDatabase } from '@sl/db/test-utils';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';


import { buildApp } from '../../../app.js';

import type { FastifyInstance } from 'fastify';

const device = { fingerprint: 'test-fingerprint-0000000000000001', name: 'Test Device', browser: 'chrome', os: 'linux', extensionVersion: '1.0.0' };

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

describe('auth module', () => {
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

  async function registerAndVerify(email: string, ip: string, password = 'correcthorsebattery12') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      payload: { email, password, device },
    });
    expect(res.statusCode).toBe(201);
    const { userId } = res.json();

    const mail = app.mailer.sentEmails.at(-1);
    expect(mail?.to).toBe(email);
    const token = extractToken(mail!.html);

    const verifyRes = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', remoteAddress: ip, payload: { token } });
    expect(verifyRes.statusCode).toBe(200);

    return userId as string;
  }

  it('registers, verifies, logs in, refreshes, and logs out', async () => {
    const ip = nextIp();
    const email = 'flow@example.com';
    await registerAndVerify(email, ip);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device },
    });
    expect(loginRes.statusCode).toBe(200);
    const login = loginRes.json();
    expect(login.status).toBe('ok');
    expect(login.accessToken).toBeTruthy();
    expect(login.refreshToken).toBeTruthy();

    // access token works against a protected route
    const meRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
  });

  it('rejects login before email verification', async () => {
    const ip = nextIp();
    const email = 'unverified@example.com';
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });

    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('AUTH_EMAIL_NOT_VERIFIED');
  });

  it('refresh rotation: old refresh token is rejected after rotation, reuse revokes the family', async () => {
    const ip = nextIp();
    const email = 'rotation@example.com';
    await registerAndVerify(email, ip);
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });
    const { refreshToken: rt1 } = loginRes.json();

    const refresh1 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', remoteAddress: ip, payload: { refreshToken: rt1 } });
    expect(refresh1.statusCode).toBe(200);
    const { refreshToken: rt2 } = refresh1.json();
    expect(rt2).not.toBe(rt1);

    // rt2 (current) still works
    const refresh2 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', remoteAddress: ip, payload: { refreshToken: rt2 } });
    expect(refresh2.statusCode).toBe(200);

    // rt1 was already rotated away — reusing it must fail AND revoke the family
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', remoteAddress: ip, payload: { refreshToken: rt1 } });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('AUTH_TOKEN_REUSED');

    const { refreshToken: rt3 } = refresh2.json();
    const afterRevoke = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', remoteAddress: ip, payload: { refreshToken: rt3 } });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('locks the account after 5 failed logins', async () => {
    const ip = nextIp();
    const email = 'lockout@example.com';
    await registerAndVerify(email, ip);

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'wrong-password-123', device } });
      expect(res.statusCode).toBe(401);
    }

    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });
    expect(res.statusCode).toBe(423);
    expect(res.json().code).toBe('AUTH_ACCOUNT_LOCKED');
  });

  it('2FA: enroll, confirm, then step-up login with a TOTP code', async () => {
    const ip = nextIp();
    const email = '2fa@example.com';
    await registerAndVerify(email, ip);
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });
    const { accessToken } = loginRes.json();

    const enrollRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enroll',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    expect(enrollRes.statusCode).toBe(200);
    const { secret, recoveryCodes } = enrollRes.json();
    expect(recoveryCodes).toHaveLength(10);

    const code = authenticator.generate(secret);
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enroll/confirm',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { code },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().enabled).toBe(true);

    // Next login now requires MFA step-up.
    const secondLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });
    expect(secondLogin.statusCode).toBe(200);
    const pending = secondLogin.json();
    expect(pending.status).toBe('mfa_required');

    const newCode = authenticator.generate(secret);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      remoteAddress: ip,
      payload: { mfaTicket: pending.mfaTicket, code: newCode },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().accessToken).toBeTruthy();
  });

  it('enforces the device limit and reports the device list', async () => {
    const ip = nextIp();
    const email = 'devicelimit@example.com';
    await registerAndVerify(email, ip);

    // trial (no subscription) device limit is 1 — a second distinct device
    // should be rejected with DEVICE_LIMIT_REACHED.
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });
    expect(first.statusCode).toBe(200);

    const secondDevice = { ...device, fingerprint: 'different-fingerprint-000000002' };
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device: secondDevice } });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.code).toBe('DEVICE_LIMIT_REACHED');
    expect(Array.isArray(body.details.devices)).toBe(true);
    expect(body.details.devices.length).toBeGreaterThan(0);
  });

  it('password reset revokes all sessions', async () => {
    const ip = nextIp();
    const email = 'reset@example.com';
    await registerAndVerify(email, ip);
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });
    const { refreshToken } = loginRes.json();

    await app.inject({ method: 'POST', url: '/api/v1/auth/password/reset-request', remoteAddress: ip, payload: { email } });
    const mail = app.mailer.sentEmails.at(-1);
    const token = extractToken(mail!.html);

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset-confirm',
      remoteAddress: ip,
      payload: { token, password: 'brandnewpassword12' },
    });
    expect(confirmRes.statusCode).toBe(200);

    // old refresh token no longer works
    const refreshAttempt = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', remoteAddress: ip, payload: { refreshToken } });
    expect(refreshAttempt.statusCode).toBe(401);

    // new password works
    const newLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'brandnewpassword12', device } });
    expect(newLogin.statusCode).toBe(200);
  });

  it('CSRF: rejects a cookie-session mutation without the CSRF token, accepts a bearer call without one', async () => {
    const ip = nextIp();
    const email = 'csrf@example.com';
    await registerAndVerify(email, ip);
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: ip, payload: { email, password: 'correcthorsebattery12', device } });
    const setCookies = loginRes.cookies;
    const atCookie = setCookies.find((c) => c.name === 'sl_at')!;

    // No CSRF cookie/header at all -> rejected
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      remoteAddress: ip,
      cookies: { sl_at: atCookie.value },
      payload: { currentPassword: 'correcthorsebattery12', newPassword: 'anothernewpassword12' },
    });
    expect(noCsrf.statusCode).toBe(403);

    // Bearer calls (the extension's auth method) are never subject to CSRF —
    // the Authorization header can't be set by a cross-site form/script.
    const bearerNoCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${loginRes.json().accessToken}` },
      payload: { currentPassword: 'correcthorsebattery12', newPassword: 'anothernewpassword12' },
    });
    expect(bearerNoCsrf.statusCode).toBe(200);
  });
});
