// Auth fixtures for tests/e2e, driven through the real HTTP API (never a
// hand-minted JWT) — mirrors apps/api/src/test/qa/helpers.ts's
// createUserSession/createAdminSession, adapted to run out-of-process
// against a real running server (plain `fetch`, not `app.inject`) and to
// use helpers/db.ts's direct-DB email-verification/admin-promotion (see
// that file's header for why).
import { authenticator } from 'otplib';

import { connect, markEmailVerified, promoteToAdmin } from './db.js';

export interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

export const TEST_PASSWORD = 'correcthorsebattery12';

export function deviceFingerprint(seed: string) {
  return {
    fingerprint: `e2e-${seed}-${'x'.repeat(Math.max(0, 24 - seed.length))}`.slice(0, 64),
    name: 'QA e2e device',
    browser: 'chrome',
    os: 'linux',
    extensionVersion: '0.1.0',
  };
}

// Same literal string as playwright.config.ts's top-level
// `use.extraHTTPHeaders` — see that config's own comment for why: a
// session this file creates via plain `fetch` must present the same
// "User-Agent family" a spec's later `request.post('/auth/refresh', ...)`
// call does (Playwright's APIRequestContext, not this file's `fetch`), or
// the refresh-token-family reuse detector treats the mismatch as theft and
// revokes the whole family (`AUTH_TOKEN_REUSED`) — reproduced directly
// while authoring journey (d).
const E2E_USER_AGENT = 'sniper-ledger-e2e-suite/1.0';

async function postJson(
  baseURL: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': E2E_USER_AGENT, ...headers },
    body: JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Registers + verifies (direct DB) a fresh user WITHOUT logging in or
 * registering any device — for a caller (journey (b)) that wants the
 * extension itself to be the one that logs in and registers the first
 * device, so it doesn't pre-consume the account's one-device trial-floor
 * limit (docs/05-subscriptions.md §1) with a fixture device that isn't the
 * one under test. */
export async function registerAndVerifyOnly(
  baseURL: string,
  email: string,
): Promise<{ userId: string }> {
  const register = await postJson(baseURL, '/api/v1/auth/register', {
    email,
    password: TEST_PASSWORD,
    device: deviceFingerprint('register-only'),
  });
  if (register.status !== 201)
    throw new Error(
      `registerAndVerifyOnly: register failed (${register.status}): ${JSON.stringify(register.json)}`,
    );
  const { userId } = register.json as { userId: string };
  const db = connect();
  try {
    await markEmailVerified(db, email);
  } finally {
    await db.end({ timeout: 5 });
  }
  return { userId };
}

/** Registers a fresh user, verifies it (direct DB — see helpers/db.ts) and
 * logs in. Returns tokens plus the device fingerprint used, so a caller
 * that also needs to hit `GET /devices` can match on it. */
export async function registerAndLogin(
  baseURL: string,
  email: string,
  fingerprintSeed: string,
): Promise<Session & { fingerprint: string }> {
  const device = deviceFingerprint(fingerprintSeed);
  const register = await postJson(baseURL, '/api/v1/auth/register', {
    email,
    password: TEST_PASSWORD,
    device,
  });
  if (register.status !== 201)
    throw new Error(
      `registerAndLogin: register failed (${register.status}): ${JSON.stringify(register.json)}`,
    );

  const db = connect();
  try {
    await markEmailVerified(db, email);
  } finally {
    await db.end({ timeout: 5 });
  }

  const login = await postJson(baseURL, '/api/v1/auth/login', {
    email,
    password: TEST_PASSWORD,
    device,
  });
  if (login.status !== 200)
    throw new Error(
      `registerAndLogin: login failed (${login.status}): ${JSON.stringify(login.json)}`,
    );
  const body = login.json as { status: string; accessToken?: string; refreshToken?: string };
  if (body.status !== 'ok' || !body.accessToken || !body.refreshToken) {
    throw new Error(`registerAndLogin: unexpected login response: ${JSON.stringify(body)}`);
  }
  const meRes = await fetch(`${baseURL}/api/v1/users/me`, {
    headers: { authorization: `Bearer ${body.accessToken}` },
  });
  const me = (await meRes.json()) as { id: string };
  return {
    userId: me.id,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    fingerprint: device.fingerprint,
  };
}

/** Registers, verifies, promotes to admin (direct DB) and drives the real
 * mandatory admin-2FA-enrollment flow through its actual routes. */
export async function createAdminSession(
  baseURL: string,
  email: string,
  fingerprintSeed: string,
  adminRole: 'super_admin' | 'support' | 'analyst' | 'billing' = 'super_admin',
): Promise<Session> {
  const device = deviceFingerprint(fingerprintSeed);
  const register = await postJson(baseURL, '/api/v1/auth/register', {
    email,
    password: TEST_PASSWORD,
    device,
  });
  if (register.status !== 201)
    throw new Error(
      `createAdminSession: register failed (${register.status}): ${JSON.stringify(register.json)}`,
    );
  const { userId } = register.json as { userId: string };

  const db = connect();
  try {
    await markEmailVerified(db, email);
    await promoteToAdmin(db, userId, adminRole);
  } finally {
    await db.end({ timeout: 5 });
  }

  const login = await postJson(baseURL, '/api/v1/auth/login', {
    email,
    password: TEST_PASSWORD,
    device,
  });
  if (login.status !== 200)
    throw new Error(
      `createAdminSession: login failed (${login.status}): ${JSON.stringify(login.json)}`,
    );
  const loginBody = login.json as { status: string; mfaTicket?: string };
  if (loginBody.status !== 'mfa_required' || !loginBody.mfaTicket) {
    throw new Error(
      `createAdminSession: expected an admin-enrollment mfaTicket, got: ${JSON.stringify(loginBody)}`,
    );
  }

  const enroll = await postJson(baseURL, '/api/v1/auth/totp/enroll', {
    mfaTicket: loginBody.mfaTicket,
  });
  if (enroll.status !== 200)
    throw new Error(
      `createAdminSession: enroll failed (${enroll.status}): ${JSON.stringify(enroll.json)}`,
    );
  const { secret } = enroll.json as { secret: string };

  const confirm = await postJson(baseURL, '/api/v1/auth/totp/enroll/confirm', {
    mfaTicket: loginBody.mfaTicket,
    code: authenticator.generate(secret),
  });
  if (confirm.status !== 200)
    throw new Error(
      `createAdminSession: enroll/confirm failed (${confirm.status}): ${JSON.stringify(confirm.json)}`,
    );
  const confirmBody = confirm.json as {
    enabled: boolean;
    tokens?: { accessToken: string; refreshToken: string };
  };
  if (!confirmBody.tokens)
    throw new Error(
      `createAdminSession: enroll/confirm did not complete the pending login: ${JSON.stringify(confirmBody)}`,
    );

  return {
    userId,
    accessToken: confirmBody.tokens.accessToken,
    refreshToken: confirmBody.tokens.refreshToken,
  };
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
