// Auth business logic. Every function takes the pieces of the Fastify
// instance it needs explicitly (rather than the whole instance) so it stays
// easy to unit-test in isolation; modules/auth/index.ts wires these to
// routes.


import { devices, users, type Database, type User } from '@sl/db';
import {
  type DeviceFingerprint,
  type LoginResponse,
  type MfaEnrollResponse,
} from '@sl/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { verifySecret, hashSecret, randomToken, fastHash, encryptTotpSecret, decryptTotpSecret, reencryptTotpSecret } from '../../lib/crypto.js';
import { findOrRegisterDevice } from '../../lib/devices.js';
import { AppErrors } from '../../lib/errors.js';
import { recordSuspiciousIpIfAny, upsertIpActivity } from '../../lib/ip-activity.js';
import { newId } from '../../lib/ids.js';
import { assertNotLocked, checkSlidingWindowRateLimit, recordFailedLogin, resetLoginFailures } from '../../lib/lockout.js';
import { uaFamiliesCompatible } from '../../lib/ua.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  MFA_TICKET_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  generateFamilyId,
  generateMfaTicket,
  generateRefreshToken,
  signAccessToken,
} from '../../lib/tokens.js';

import * as repo from './repo.js';
import { generateRecoveryCodes, generateTotpSecret, totpKeyUri, verifyTotpCode } from './totp.js';

import type { EntitlementProvider } from '../../lib/entitlements.js';
import type { Mailer } from '../../lib/mailer.js';
import type { Redis } from 'ioredis';

export interface AuthContext {
  db: Database;
  redis: Redis;
  entitlements: EntitlementProvider;
  mailer: Mailer;
  jwtPrivateKey: string;
  cookieSecret: string;
  /** Optional structured logger (fastify.log in production; omitted in unit
   * tests that build an ad-hoc context). Only ever used for non-fatal
   * warnings — nothing security-sensitive is ever logged here (see
   * docs/09-security.md "Logging & redaction"). */
  log?: { warn: (obj: unknown, msg?: string) => void };
}

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
// Deliberately looser than the 5-failure DB account lockout
// (lib/lockout.ts's LOCKOUT_THRESHOLD): this Redis sliding window is a
// coarser abuse guard (catches one IP hammering many *different* accounts,
// which the per-account lockout can't see), not the primary brute-force
// defence — the per-account lockout is. Keeping it above the lockout
// threshold means the account-specific 423 fires before this 429 does for
// the common "one attacker, one account" case.
const LOGIN_RATE_LIMIT_MAX = 20;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function verifyTicketKey(ticket: string): string {
  return `auth:mfa-ticket:${ticket}`;
}

interface PendingLogin {
  userId: string;
  device: DeviceFingerprint;
  ip: string | null;
  userAgent: string | null;
  mode: 'verify' | 'enroll';
}

function stripUser(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    role: user.role,
    emailVerifiedAt: user.emailVerifiedAt,
    totpEnabled: Boolean(user.totpEnabledAt),
  };
}

// ---------------------------------------------------------------------------
// Registration / email verification
// ---------------------------------------------------------------------------

export async function register(
  ctx: AuthContext,
  input: { email: string; password: string; timezone?: string; referralCode?: string },
): Promise<{ userId: string }> {
  const existing = await repo.findUserByEmail(ctx.db, input.email);
  if (existing) {
    throw AppErrors.conflict('An account with this email already exists.');
  }

  const passwordHash = await hashSecret(input.password);
  const id = newId();
  await ctx.db.insert(users).values({
    id,
    email: input.email,
    passwordHash,
    timezone: input.timezone ?? 'UTC',
    referralCode: input.referralCode ?? null,
  });

  await sendVerificationEmail(ctx, id, input.email);

  return { userId: id };
}

export async function sendVerificationEmail(ctx: AuthContext, userId: string, email: string): Promise<void> {
  const token = randomToken(32);
  const tokenHash = fastHash(token);
  await repo.createEmailVerification(ctx.db, userId, tokenHash, new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS));

  const { verifyEmailHtml, verifyEmailText } = await import('../../emails/templates.js');
  await ctx.mailer.send({
    to: email,
    subject: "Verify your email — The Sniper's Ledger",
    html: verifyEmailHtml(token),
    text: verifyEmailText(token),
  });
}

export async function resendVerification(ctx: AuthContext, email: string): Promise<void> {
  const user = await repo.findUserByEmail(ctx.db, email);
  if (!user || user.emailVerifiedAt) return; // never reveal whether the account exists / is verified
  await sendVerificationEmail(ctx, user.id, user.email);
}

export async function verifyEmail(ctx: AuthContext, token: string): Promise<void> {
  const tokenHash = fastHash(token);
  const record = await repo.findValidEmailVerification(ctx.db, tokenHash);
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw AppErrors.tokenInvalid('Verification link is invalid or has expired.');
  }
  await repo.consumeEmailVerification(ctx.db, record.id);
  await ctx.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, record.userId));
}

// ---------------------------------------------------------------------------
// Login / MFA / token issuance
// ---------------------------------------------------------------------------

export async function completeLogin(
  ctx: AuthContext,
  user: User,
  device: DeviceFingerprint,
  ip: string | null,
  userAgent: string | null,
): Promise<Extract<LoginResponse, { status: 'ok' }>> {
  const { id: deviceId } = await findOrRegisterDevice(ctx.db, ctx.entitlements, user.id, device, ip);
  const entitlements = await ctx.entitlements.getEntitlements(user.id);

  const familyId = generateFamilyId();
  const refresh = generateRefreshToken();
  const sessionId = await repo.createSession(ctx.db, {
    userId: user.id,
    deviceId,
    refreshTokenHash: refresh.hash,
    familyId,
    ip,
    userAgent,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });

  // `bump_row_version` fires on *every* UPDATE to `users`, including this
  // benign lastLoginAt/lastIp bookkeeping one — so it must happen BEFORE the
  // token is signed, using the row_version it returns, or the access token
  // this call issues would carry an already-stale `ver` claim and fail
  // `authenticate`'s row_version check on its very first use.
  const [updated] = await ctx.db
    .update(users)
    .set({ lastLoginAt: new Date(), lastIp: ip })
    .where(eq(users.id, user.id))
    .returning({ rowVersion: users.rowVersion });

  const accessToken = await signAccessToken(
    { sub: user.id, sid: sessionId, did: deviceId, role: user.role, plan: entitlements.plan, ver: updated?.rowVersion ?? user.rowVersion },
    ctx.jwtPrivateKey,
  );

  // IP monitoring (docs/09-security.md "IP monitoring"): upsert the rolling
  // per-(ip,user) counter with geo/ASN enrichment, then check for a new
  // country / impossible travel and raise a `flags` row if so. Best-effort —
  // never blocks or fails a login; a monitoring hiccup must not become an
  // availability incident for the thing it's supposed to be protecting.
  if (ip) {
    void upsertIpActivity(ctx.db, { ip, userId: user.id, deviceId })
      .then((activity) => recordSuspiciousIpIfAny(ctx.db, { userId: user.id, ip, activity }))
      .catch((err) => ctx.log?.warn({ err }, 'ip-activity monitoring failed (non-fatal)'));
  }

  return { status: 'ok', accessToken, refreshToken: refresh.token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export async function login(
  ctx: AuthContext,
  input: { email: string; password: string; device: DeviceFingerprint },
  ip: string | null,
  userAgent: string | null,
): Promise<LoginResponse> {
  await checkSlidingWindowRateLimit(ctx.redis, `ratelimit:login:ip:${ip ?? 'unknown'}`, LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS);
  await checkSlidingWindowRateLimit(ctx.redis, `ratelimit:login:account:${input.email}`, LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS);

  const user = await repo.findUserByEmail(ctx.db, input.email);
  if (!user) throw AppErrors.invalidCredentials();

  assertNotLocked(user.lockedUntil);

  const valid = await verifySecret(user.passwordHash, input.password);
  if (!valid) {
    await recordFailedLogin(ctx.db, user.id, user.failedLoginCount);
    throw AppErrors.invalidCredentials();
  }

  if (!user.emailVerifiedAt) throw AppErrors.emailNotVerified();
  if (user.status !== 'active') throw AppErrors.forbidden('Account is not active.');

  // Cross-agent seam (docs/05-subscriptions.md §"Cross-agent touchpoints"):
  // modules/bans owns ban creation/lifting; this is the login-time check it
  // asked the auth module to call, covering account/IP/device/hwid bans —
  // a superset of `users.status === 'banned'` (which is also covered above,
  // since an account ban sets that too, but IP/device/hwid bans never do).
  const { checkBans } = await import('../bans/service.js');
  const banCheck = await checkBans(ctx.db, { userId: user.id, ip, deviceFingerprintHash: input.device.fingerprint });
  if (banCheck.banned) throw AppErrors.forbidden('This account, device, or network has been banned.');

  await resetLoginFailures(ctx.db, user.id);

  const requiresEnrollment = user.role === 'admin' && !user.totpEnabledAt;
  const requiresVerification = Boolean(user.totpEnabledAt);

  if (requiresEnrollment || requiresVerification) {
    const ticket = generateMfaTicket();
    const pending: PendingLogin = {
      userId: user.id,
      device: input.device,
      ip,
      userAgent,
      mode: requiresEnrollment ? 'enroll' : 'verify',
    };
    await ctx.redis.set(verifyTicketKey(ticket), JSON.stringify(pending), 'EX', MFA_TICKET_TTL_SECONDS);
    return { status: 'mfa_required', mfaTicket: ticket, expiresIn: MFA_TICKET_TTL_SECONDS };
  }

  return completeLogin(ctx, user, input.device, ip, userAgent);
}

async function peekPendingLogin(ctx: AuthContext, ticket: string): Promise<PendingLogin> {
  const raw = await ctx.redis.get(verifyTicketKey(ticket));
  if (!raw) throw AppErrors.tokenInvalid('MFA ticket is invalid or has expired. Please log in again.');
  return JSON.parse(raw) as PendingLogin;
}

export async function mfaVerify(
  ctx: AuthContext,
  input: { mfaTicket: string; code: string },
): Promise<Extract<LoginResponse, { status: 'ok' }>> {
  const pending = await peekPendingLogin(ctx, input.mfaTicket);
  if (pending.mode !== 'verify') {
    throw AppErrors.mfaRequired();
  }

  const user = await repo.findUserById(ctx.db, pending.userId);
  if (!user || !user.totpSecretEnc) throw AppErrors.tokenInvalid('Account no longer has 2FA enabled.');

  const attemptsKey = `${verifyTicketKey(input.mfaTicket)}:attempts`;
  const attempts = await ctx.redis.incr(attemptsKey);
  await ctx.redis.expire(attemptsKey, MFA_TICKET_TTL_SECONDS);
  if (attempts > 8) {
    await ctx.redis.del(verifyTicketKey(input.mfaTicket), attemptsKey);
    throw AppErrors.tokenInvalid('Too many attempts. Please log in again.');
  }

  const secretBlob = Buffer.from(user.totpSecretEnc);
  const secret = decryptTotpSecret(secretBlob, ctx.cookieSecret);
  let valid = /^\d{6}$/.test(input.code) && verifyTotpCode(secret, input.code);

  if (!valid) {
    valid = await tryConsumeRecoveryCode(ctx.db, user.id, input.code);
  }

  if (!valid) throw AppErrors.mfaInvalid();

  // Key rotation (docs/09-security.md "Key rotation"): opportunistically
  // migrate this row onto the current active key id on a successful read —
  // a no-op (same bytes back) unless an operator has rotated
  // TOTP_ENCRYPTION_ACTIVE_KEY_ID since this row was last written.
  await maybeReencryptTotpSecret(ctx, user.id, secretBlob);

  await ctx.redis.del(verifyTicketKey(input.mfaTicket), attemptsKey);
  return completeLogin(ctx, user, pending.device, pending.ip, pending.userAgent);
}

/** See `reencryptTotpSecret` in lib/crypto.ts. Best-effort — never blocks or
 * fails the login/disable flow it's called from. */
async function maybeReencryptTotpSecret(ctx: AuthContext, userId: string, blob: Buffer): Promise<void> {
  try {
    const rotated = reencryptTotpSecret(blob, ctx.cookieSecret);
    if (!rotated.equals(blob)) {
      await ctx.db.update(users).set({ totpSecretEnc: rotated }).where(eq(users.id, userId));
    }
  } catch (err) {
    ctx.log?.warn({ err }, 'TOTP secret key-rotation re-encrypt failed (non-fatal)');
  }
}

async function tryConsumeRecoveryCode(db: Database, userId: string, code: string): Promise<boolean> {
  const unused = await repo.findUnusedRecoveryCodes(db, userId);
  for (const row of unused) {
    if (await verifySecret(row.codeHash, code)) {
      await repo.consumeRecoveryCode(db, row.id);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Refresh / logout
// ---------------------------------------------------------------------------

export async function refresh(
  ctx: AuthContext,
  refreshToken: string,
  presented?: { userAgent?: string | null; device?: DeviceFingerprint | null },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const hash = fastHash(refreshToken);
  const session = await repo.findSessionByRefreshHash(ctx.db, hash);
  if (!session) throw AppErrors.tokenInvalid('Invalid refresh token.');

  if (session.revokedAt) {
    // Reuse of an already-revoked (superseded or explicitly logged-out)
    // refresh token: treat as compromise, revoke the whole family.
    await repo.revokeSessionFamily(ctx.db, session.familyId, 'token_reuse_detected');
    throw AppErrors.tokenReused();
  }

  if (session.expiresAt.getTime() < Date.now()) {
    throw AppErrors.tokenExpired();
  }

  // Refresh-token binding (docs/09-security.md "Session security"): a
  // refresh token is scoped to the device/browser-family it was issued to.
  // The session already carries the User-Agent it was created/last-rotated
  // with — compare that against what's presented now. A mismatch is treated
  // exactly like reuse of a stolen token: revoke the whole family rather
  // than silently rotating for whoever holds the raw token bytes.
  if (session.userAgent && !uaFamiliesCompatible(session.userAgent, presented?.userAgent)) {
    await repo.revokeSessionFamily(ctx.db, session.familyId, 'device_binding_mismatch');
    throw AppErrors.tokenReused();
  }

  // Same reasoning for an explicitly-presented device fingerprint (optional,
  // additive field — see `refreshRequestSchema`): if the caller sends one at
  // all, it must match the fingerprint the session's device was registered
  // under.
  if (presented?.device && session.deviceId) {
    const boundDevice = await ctx.db.query.devices.findFirst({ where: eq(devices.id, session.deviceId) });
    if (boundDevice && boundDevice.fingerprintHash !== presented.device.fingerprint) {
      await repo.revokeSessionFamily(ctx.db, session.familyId, 'device_binding_mismatch');
      throw AppErrors.tokenReused();
    }
  }

  const user = await repo.findUserById(ctx.db, session.userId);
  if (!user || user.status !== 'active') throw AppErrors.sessionRevoked();

  const newRefresh = generateRefreshToken();
  const newSessionId = await repo.rotateSession(
    ctx.db,
    { id: session.id, userId: session.userId, deviceId: session.deviceId, familyId: session.familyId, ip: session.ip, userAgent: session.userAgent },
    newRefresh.hash,
    new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  );

  const entitlements = await ctx.entitlements.getEntitlements(user.id);
  const accessToken = await signAccessToken(
    { sub: user.id, sid: newSessionId, did: session.deviceId, role: user.role, plan: entitlements.plan, ver: user.rowVersion },
    ctx.jwtPrivateKey,
  );

  return { accessToken, refreshToken: newRefresh.token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export async function logout(ctx: AuthContext, refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  const hash = fastHash(refreshToken);
  const session = await repo.findSessionByRefreshHash(ctx.db, hash);
  if (session && !session.revokedAt) {
    await repo.revokeSession(ctx.db, session.id, 'user');
  }
}

export async function logoutAll(ctx: AuthContext, userId: string): Promise<void> {
  await repo.revokeAllUserSessions(ctx.db, userId, 'user');
  await repo.bumpUserVersion(ctx.db, userId);
}

// ---------------------------------------------------------------------------
// Password reset / change
// ---------------------------------------------------------------------------

export async function requestPasswordReset(ctx: AuthContext, email: string, ip: string | null): Promise<void> {
  const user = await repo.findUserByEmail(ctx.db, email);
  if (!user) return; // never reveal account existence
  const token = randomToken(32);
  const tokenHash = fastHash(token);
  await repo.createPasswordReset(ctx.db, user.id, tokenHash, new Date(Date.now() + PASSWORD_RESET_TTL_MS), ip);

  const { resetPasswordHtml, resetPasswordText } = await import('../../emails/templates.js');
  await ctx.mailer.send({
    to: user.email,
    subject: "Reset your password — The Sniper's Ledger",
    html: resetPasswordHtml(token),
    text: resetPasswordText(token),
  });
}

export async function confirmPasswordReset(ctx: AuthContext, token: string, newPassword: string): Promise<void> {
  const tokenHash = fastHash(token);
  const record = await repo.findValidPasswordReset(ctx.db, tokenHash);
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw AppErrors.tokenInvalid('Reset link is invalid or has expired.');
  }

  const passwordHash = await hashSecret(newPassword);
  await ctx.db.update(users).set({ passwordHash, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, record.userId));
  await repo.consumePasswordReset(ctx.db, record.id);
  await repo.revokeAllUserSessions(ctx.db, record.userId, 'password_changed');
  await repo.bumpUserVersion(ctx.db, record.userId);
}

export async function changePassword(ctx: AuthContext, userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await repo.findUserById(ctx.db, userId);
  if (!user) throw AppErrors.notFound('user');
  const valid = await verifySecret(user.passwordHash, currentPassword);
  if (!valid) throw AppErrors.invalidCredentials();

  const passwordHash = await hashSecret(newPassword);
  await ctx.db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  await repo.revokeAllUserSessions(ctx.db, userId, 'password_changed');
  await repo.bumpUserVersion(ctx.db, userId);
}

// ---------------------------------------------------------------------------
// TOTP enrollment / disable
// ---------------------------------------------------------------------------

const pendingEnrollmentSchema = z.object({ secret: z.string(), recoveryCodes: z.array(z.string()) });

function pendingEnrollmentKey(userId: string): string {
  return `auth:totp-pending:${userId}`;
}

/** Resolves the caller for the two TOTP-enrollment entry points: either an
 * already-authenticated user turning 2FA on voluntarily, or an admin
 * bootstrapping mandatory 2FA via the `mfaTicket` their (TOTP-less) login
 * returned. Returns the target userId either way. */
export async function resolveEnrollmentSubject(
  ctx: AuthContext,
  authUserId: string | undefined,
  mfaTicket: string | undefined,
): Promise<string> {
  if (authUserId) return authUserId;
  if (!mfaTicket) throw AppErrors.tokenInvalid('Authentication or an MFA ticket is required.');
  const pending = await peekPendingLogin(ctx, mfaTicket);
  if (pending.mode !== 'enroll') throw AppErrors.tokenInvalid('This ticket is not an enrollment ticket.');
  return pending.userId;
}

export async function beginTotpEnrollment(ctx: AuthContext, userId: string, email: string): Promise<MfaEnrollResponse> {
  const user = await repo.findUserById(ctx.db, userId);
  if (!user) throw AppErrors.notFound('user');
  if (user.totpEnabledAt) throw AppErrors.conflict('Two-factor authentication is already enabled.');

  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes(10);
  await ctx.redis.set(pendingEnrollmentKey(userId), JSON.stringify({ secret, recoveryCodes }), 'EX', 10 * 60);

  return { secret, otpauthUrl: totpKeyUri(secret, email), recoveryCodes };
}

export interface ConfirmEnrollmentResult {
  tokens?: { accessToken: string; refreshToken: string; expiresIn: number };
}

export async function confirmTotpEnrollment(
  ctx: AuthContext,
  userId: string,
  code: string,
  mfaTicket: string | undefined,
): Promise<ConfirmEnrollmentResult> {
  const raw = await ctx.redis.get(pendingEnrollmentKey(userId));
  if (!raw) throw AppErrors.tokenInvalid('No pending 2FA enrollment found. Start enrollment again.');
  const pending = pendingEnrollmentSchema.parse(JSON.parse(raw));

  if (!verifyTotpCode(pending.secret, code)) throw AppErrors.mfaInvalid();

  const encrypted = encryptTotpSecret(pending.secret, ctx.cookieSecret);
  const hashedCodes = await Promise.all(pending.recoveryCodes.map((c) => hashSecret(c)));

  await ctx.db.update(users).set({ totpSecretEnc: encrypted, totpEnabledAt: new Date() }).where(eq(users.id, userId));
  await repo.insertRecoveryCodes(ctx.db, userId, hashedCodes);
  await ctx.redis.del(pendingEnrollmentKey(userId));
  await repo.bumpUserVersion(ctx.db, userId);

  if (mfaTicket) {
    // Admin bootstrap path: the caller had no session yet (their login was
    // blocked pending enrollment) — complete that login now.
    const pending2 = await peekPendingLogin(ctx, mfaTicket).catch(() => undefined);
    if (pending2 && pending2.userId === userId) {
      await ctx.redis.del(verifyTicketKey(mfaTicket));
      const user = await repo.findUserById(ctx.db, userId);
      if (user) {
        const result = await completeLogin(ctx, user, pending2.device, pending2.ip, pending2.userAgent);
        return { tokens: { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresIn: result.expiresIn } };
      }
    }
  }

  return {};
}

export async function disableTotp(ctx: AuthContext, userId: string, currentPassword: string, code: string): Promise<void> {
  const user = await repo.findUserById(ctx.db, userId);
  if (!user || !user.totpSecretEnc) throw AppErrors.conflict('Two-factor authentication is not enabled.');

  const passwordValid = await verifySecret(user.passwordHash, currentPassword);
  if (!passwordValid) throw AppErrors.invalidCredentials();

  const secret = decryptTotpSecret(Buffer.from(user.totpSecretEnc), ctx.cookieSecret);
  const codeValid = verifyTotpCode(secret, code) || (await tryConsumeRecoveryCode(ctx.db, userId, code));
  if (!codeValid) throw AppErrors.mfaInvalid();

  await ctx.db.update(users).set({ totpSecretEnc: null, totpEnabledAt: null }).where(eq(users.id, userId));
  await repo.deleteAllRecoveryCodes(ctx.db, userId);
  await repo.bumpUserVersion(ctx.db, userId);
}

export { stripUser };
