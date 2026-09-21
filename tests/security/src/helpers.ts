// Shared fixtures for the security-tests package. Every helper drives the
// real app through its public HTTP surface (app.inject) wherever a
// legitimate flow exists — admin sessions are the one place this reaches
// into the DB directly (via `app.db`, the same Drizzle instance the app
// itself uses), because there is no self-service "become an admin" API
// route, by design (docs/04-auth.md §7).

import { adminUsers, users } from '@sl/db';
import { eq } from 'drizzle-orm';
import { authenticator } from 'otplib';

import type { Database } from '@sl/db';
import type { AdminRole } from '@sl/shared';
import type { FastifyInstance } from 'fastify';

/**
 * `buildApp()`'s published type (`@sl/api/app`) is deliberately just
 * `Promise<FastifyInstance>` — the decorations (`db`, `mailer`, `config`,
 * …) come from `declare module 'fastify'` augmentations scattered across
 * `apps/api/src/plugins/*.ts`, which apply within that package's own
 * compilation but aren't re-exported for an external consumer that only
 * imports the compiled `app.d.ts`. Rather than deep-importing `@sl/api`'s
 * internal `dist/plugins/*.d.ts` files (which its `package.json` `exports`
 * deliberately doesn't expose — this package sees the same public surface
 * any other consumer of `@sl/api/app` would), this is a narrow, local
 * re-statement of just the handful of decorations these tests actually
 * touch. If a route this package tests ever changes shape, a failing
 * `typecheck` here is the signal to update it — the runtime app is always
 * the real one built by the real `buildApp()`. */
export type TestApp = FastifyInstance & {
  db: Database;
  mailer: { sentEmails: Array<{ to: string; subject: string; html: string; text: string }> };
  config: Record<string, unknown>;
};

export const TEST_PASSWORD = 'correcthorsebattery12';

export function device(fingerprint: string) {
  return { fingerprint, name: 'Security Test Device', browser: 'chrome', os: 'linux', extensionVersion: '1.0.0' };
}

let ipCounter = 10;
/** A fresh loopback-range IP per call, so one test's per-IP rate limiting
 * never leaks into another's (matching @sl/api's own test convention). */
export function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 254}`;
}

export function extractToken(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No verification/reset token found in email body:\n${html}`);
  return decodeURIComponent(match[1]!);
}

export interface UserSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

/** Registers, verifies and logs in a plain (non-admin) user through the
 * real HTTP routes — nothing about this path is a test-only shortcut. */
export async function createUserSession(app: TestApp, email: string, fp: string): Promise<UserSession> {
  const ip = nextIp();
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD, device: device(fp) },
  });
  if (registerRes.statusCode !== 201) {
    throw new Error(`createUserSession: register failed (${registerRes.statusCode}): ${registerRes.body}`);
  }
  const { userId } = registerRes.json() as { userId: string };

  const mail = app.mailer.sentEmails.at(-1);
  const token = extractToken(mail!.html);
  await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', remoteAddress: ip, payload: { token } });

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

/**
 * Registers + verifies a user, promotes it to an admin with the given role
 * directly via the DB (the `admin_users` row — there is no self-service
 * "become an admin" API route, by design), then drives the real *mandatory*
 * admin-2FA-enrollment flow (docs/04-auth.md §6 "admin accounts must have
 * 2FA enabled to log in at all") through its actual HTTP routes:
 * `/auth/login` (returns an `enroll`-mode `mfaTicket` since the account has
 * no TOTP secret yet) → `/auth/totp/enroll` → `/auth/totp/enroll/confirm`
 * (which both persists the secret and completes the pending login in one
 * response). The TOTP code itself is computed locally with `otplib` from
 * the secret the enroll step hands back — never a hand-minted JWT, never a
 * skipped security check.
 */
export async function createAdminSession(app: TestApp, role: AdminRole, email: string, fp: string): Promise<UserSession> {
  const ip = nextIp();
  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: ip,
    payload: { email, password: TEST_PASSWORD, device: device(fp) },
  });
  if (registerRes.statusCode !== 201) {
    throw new Error(`createAdminSession: register failed (${registerRes.statusCode}): ${registerRes.body}`);
  }
  const { userId } = registerRes.json() as { userId: string };

  const mail = app.mailer.sentEmails.at(-1);
  const token = extractToken(mail!.html);
  await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', remoteAddress: ip, payload: { token } });

  await app.db.update(users).set({ role: 'admin' }).where(eq(users.id, userId));
  await app.db.insert(adminUsers).values({ id: crypto.randomUUID(), userId, adminRole: role, permissions: {} });

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
    throw new Error(`createAdminSession: expected an admin-enrollment mfaTicket, got: ${JSON.stringify(loginBody)}`);
  }

  const enrollRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/totp/enroll',
    remoteAddress: ip,
    payload: { mfaTicket: loginBody.mfaTicket },
  });
  if (enrollRes.statusCode !== 200) {
    throw new Error(`createAdminSession: enroll failed (${enrollRes.statusCode}): ${enrollRes.body}`);
  }
  const { secret } = enrollRes.json() as { secret: string };

  const confirmRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/totp/enroll/confirm',
    remoteAddress: ip,
    payload: { mfaTicket: loginBody.mfaTicket, code: authenticator.generate(secret) },
  });
  if (confirmRes.statusCode !== 200) {
    throw new Error(`createAdminSession: enroll/confirm failed (${confirmRes.statusCode}): ${confirmRes.body}`);
  }
  const confirmBody = confirmRes.json() as { enabled: boolean; tokens?: { accessToken: string; refreshToken: string } };
  if (!confirmBody.tokens) {
    throw new Error(`createAdminSession: enroll/confirm did not complete the pending login: ${JSON.stringify(confirmBody)}`);
  }
  return { userId, accessToken: confirmBody.tokens.accessToken, refreshToken: confirmBody.tokens.refreshToken };
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** A syntactically valid, non-existent UUID — for hitting a `:id` route
 * whose permission/authz gate must fire before the DB is ever consulted
 * (see authz-matrix.test.ts's comment on route-matching order). */
export const NIL_LIKE_UUID = '00000000-0000-0000-0000-000000000000';

/** Builds the real app (via `@sl/api/app`'s `buildApp()`) and asserts it's
 * ready. One call per test file's `beforeAll`, matching @sl/api's own
 * convention.
 *
 * `logger: { level: 'error' }`, not `false`: `plugins/error-handler.ts`
 * only logs at `.error` for a genuinely unexpected failure (an `AppError`
 * with `status >= 500`, or anything that isn't an `AppError`/zod validation
 * error at all) — every ordinary 4xx (expected in most of this package's
 * own assertions) logs at `.info` and stays silent here. So this prints
 * nothing for the expected-rejection tests that make up most of this
 * package, and a full stack trace the moment a test's "expected 4xx" comes
 * back a 500 instead — which is exactly the failure mode this package's
 * own tests exist to catch, and stack-trace-free `expect(...).toBe(...)`
 * diffs alone made two real bugs (an `isAppError` cross-realm `instanceof`
 * gap — see lib/errors.ts — and a route's `400` response schema colliding
 * with the app-wide error envelope) much harder to find than they needed
 * to be. */
export async function buildTestApp(): Promise<TestApp> {
  const { buildApp } = await import('@sl/api/app');
  const app = (await buildApp({ logger: { level: 'error' } })) as TestApp;
  await app.ready();
  return app;
}
