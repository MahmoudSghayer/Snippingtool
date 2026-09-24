// Shared fixtures for the QA suite (apps/api/src/test/qa/__tests__/**),
// owned by the Testing & QA agent — see docs/12-testing.md. Not itself a
// test file (doesn't match the `src/**/__tests__/*.test.ts` vitest
// include), just helpers the qa/__tests__ files import. Mirrors
// tests/security/src/helpers.ts's approach (drive the real app through its
// public HTTP surface; the DB is only touched directly where there is no
// self-service route, e.g. promoting a user to admin), adapted to this
// package's own path depth.

import { adminUsers, users } from '@sl/db';
import { eq } from 'drizzle-orm';
import { authenticator } from 'otplib';

import { buildApp } from '../../app.js';

import type { Database } from '@sl/db';
import type { AdminRole } from '@sl/shared';
import type { FastifyInstance } from 'fastify';

export type TestApp = FastifyInstance & {
  db: Database;
  mailer: { sentEmails: Array<{ to: string; subject: string; html: string; text: string }> };
};

export const TEST_PASSWORD = 'correcthorsebattery12';

export function device(fingerprint: string) {
  return {
    fingerprint,
    name: 'QA Test Device',
    browser: 'chrome',
    os: 'linux',
    extensionVersion: '1.0.0',
  };
}

let ipCounter = 20;
/** A fresh loopback-range IP per call — per-IP rate limiting in one test
 * must never leak into another (matching @sl/api's own test convention). */
export function nextIp(): string {
  ipCounter += 1;
  return `198.18.0.${ipCounter % 254}`;
}

export function extractToken(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No verification/reset token found in email body:\n${html}`);
  return decodeURIComponent(match[1]!);
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function buildTestApp(): Promise<TestApp> {
  const app = (await buildApp({ logger: false })) as TestApp;
  await app.ready();
  return app;
}

export interface UserSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

export async function createUserSession(
  app: TestApp,
  email: string,
  fp: string,
): Promise<UserSession> {
  const ip = nextIp();
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD, device: device(fp), acceptTerms: true },
  });
  if (registerRes.statusCode !== 201) {
    throw new Error(
      `createUserSession: register failed (${registerRes.statusCode}): ${registerRes.body}`,
    );
  }
  const { userId } = registerRes.json() as { userId: string };

  const mail = app.mailer.sentEmails.at(-1);
  const token = extractToken(mail!.html);
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
  if (loginRes.statusCode !== 200) {
    throw new Error(`createUserSession: login failed (${loginRes.statusCode}): ${loginRes.body}`);
  }
  const body = loginRes.json() as { status: string; accessToken?: string; refreshToken?: string };
  if (body.status !== 'ok' || !body.accessToken || !body.refreshToken) {
    throw new Error(`createUserSession: unexpected login response: ${JSON.stringify(body)}`);
  }
  return { userId, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

/** Registers + verifies + promotes to admin (DB, no self-service route) +
 * drives the real mandatory admin-2FA-enrollment flow through its actual
 * routes — never a hand-minted JWT. */
export async function createAdminSession(
  app: TestApp,
  role: AdminRole,
  email: string,
  fp: string,
): Promise<UserSession> {
  const ip = nextIp();
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD, device: device(fp), acceptTerms: true },
  });
  if (registerRes.statusCode !== 201) {
    throw new Error(
      `createAdminSession: register failed (${registerRes.statusCode}): ${registerRes.body}`,
    );
  }
  const { userId } = registerRes.json() as { userId: string };

  const mail = app.mailer.sentEmails.at(-1);
  const token = extractToken(mail!.html);
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-email',
    remoteAddress: ip,
    payload: { token },
  });

  await app.db.update(users).set({ role: 'admin' }).where(eq(users.id, userId));
  await app.db
    .insert(adminUsers)
    .values({ id: crypto.randomUUID(), userId, adminRole: role, permissions: {} });

  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD, device: device(fp) },
  });
  if (loginRes.statusCode !== 200) {
    throw new Error(`createAdminSession: login failed (${loginRes.statusCode}): ${loginRes.body}`);
  }
  const loginBody = loginRes.json() as { status: string; mfaTicket?: string };
  if (loginBody.status !== 'mfa_required' || !loginBody.mfaTicket) {
    throw new Error(
      `createAdminSession: expected an admin-enrollment mfaTicket, got: ${JSON.stringify(loginBody)}`,
    );
  }

  const enrollRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/totp/enroll',
    remoteAddress: ip,
    payload: { mfaTicket: loginBody.mfaTicket },
  });
  if (enrollRes.statusCode !== 200) {
    throw new Error(
      `createAdminSession: enroll failed (${enrollRes.statusCode}): ${enrollRes.body}`,
    );
  }
  const { secret } = enrollRes.json() as { secret: string };

  const confirmRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/totp/enroll/confirm',
    remoteAddress: ip,
    payload: { mfaTicket: loginBody.mfaTicket, code: authenticator.generate(secret) },
  });
  if (confirmRes.statusCode !== 200) {
    throw new Error(
      `createAdminSession: enroll/confirm failed (${confirmRes.statusCode}): ${confirmRes.body}`,
    );
  }
  const confirmBody = confirmRes.json() as {
    enabled: boolean;
    tokens?: { accessToken: string; refreshToken: string };
  };
  if (!confirmBody.tokens) {
    throw new Error(
      `createAdminSession: enroll/confirm did not complete the pending login: ${JSON.stringify(confirmBody)}`,
    );
  }
  return {
    userId,
    accessToken: confirmBody.tokens.accessToken,
    refreshToken: confirmBody.tokens.refreshToken,
  };
}
