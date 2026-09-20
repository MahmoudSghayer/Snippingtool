// Pure DB-access helpers for the auth module. Kept separate from service.ts
// so the business logic reads as a sequence of intent-named calls.

import {
  emailVerifications,
  passwordResets,
  sessions,
  totpRecoveryCodes,
  users,
  type Database,
  type User,
} from '@sl/db';
import { and, eq, isNull } from 'drizzle-orm';


import { newId } from '../../lib/ids.js';

export async function findUserByEmail(db: Database, email: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: and(eq(users.email, email), isNull(users.deletedAt)) });
}

export async function findUserById(db: Database, id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: and(eq(users.id, id), isNull(users.deletedAt)) });
}

export async function createEmailVerification(db: Database, userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  await db.insert(emailVerifications).values({ id: newId(), userId, tokenHash, expiresAt });
}

export async function findValidEmailVerification(db: Database, tokenHash: string) {
  return db.query.emailVerifications.findFirst({
    where: and(eq(emailVerifications.tokenHash, tokenHash), isNull(emailVerifications.consumedAt)),
  });
}

export async function consumeEmailVerification(db: Database, id: string): Promise<void> {
  await db.update(emailVerifications).set({ consumedAt: new Date() }).where(eq(emailVerifications.id, id));
}

export async function createPasswordReset(db: Database, userId: string, tokenHash: string, expiresAt: Date, ip: string | null): Promise<void> {
  await db.insert(passwordResets).values({ id: newId(), userId, tokenHash, expiresAt, requestedIp: ip });
}

export async function findValidPasswordReset(db: Database, tokenHash: string) {
  return db.query.passwordResets.findFirst({
    where: and(eq(passwordResets.tokenHash, tokenHash), isNull(passwordResets.consumedAt)),
  });
}

export async function consumePasswordReset(db: Database, id: string): Promise<void> {
  await db.update(passwordResets).set({ consumedAt: new Date() }).where(eq(passwordResets.id, id));
}

export async function createSession(
  db: Database,
  params: { userId: string; deviceId: string | null; refreshTokenHash: string; familyId: string; ip: string | null; userAgent: string | null; expiresAt: Date },
): Promise<string> {
  const id = newId();
  await db.insert(sessions).values({
    id,
    userId: params.userId,
    deviceId: params.deviceId,
    refreshTokenHash: params.refreshTokenHash,
    familyId: params.familyId,
    ip: params.ip,
    userAgent: params.userAgent,
    expiresAt: params.expiresAt,
  });
  return id;
}

export async function findSessionByRefreshHash(db: Database, refreshTokenHash: string) {
  return db.query.sessions.findFirst({ where: eq(sessions.refreshTokenHash, refreshTokenHash) });
}

export async function findSessionById(db: Database, id: string) {
  return db.query.sessions.findFirst({ where: eq(sessions.id, id) });
}

/**
 * Refresh rotation: the previous session row is revoked (reason 'rotated'),
 * never reused in place — a *new* row is inserted with the new hash, same
 * family/user/device. This is deliberate, not incidental: reuse detection
 * (see service.ts `refresh()`) works by looking up a *presented* refresh
 * token's hash and checking whether the row it matches is already revoked.
 * If rotation instead overwrote the hash on the same row, the old hash
 * would match nothing at all after rotation (not "found but revoked"),
 * making reuse silently indistinguishable from "never existed" — a real bug
 * caught by this module's own integration test.
 */
export async function rotateSession(
  db: Database,
  previous: { id: string; userId: string; deviceId: string | null; familyId: string; ip: string | null; userAgent: string | null },
  newRefreshTokenHash: string,
  expiresAt: Date,
): Promise<string> {
  await revokeSession(db, previous.id, 'rotated');
  return createSession(db, {
    userId: previous.userId,
    deviceId: previous.deviceId,
    refreshTokenHash: newRefreshTokenHash,
    familyId: previous.familyId,
    ip: previous.ip,
    userAgent: previous.userAgent,
    expiresAt,
  });
}

export async function revokeSession(db: Database, sessionId: string, reason: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date(), revokedReason: reason }).where(eq(sessions.id, sessionId));
}

export async function revokeSessionFamily(db: Database, familyId: string, reason: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date(), revokedReason: reason }).where(eq(sessions.familyId, familyId));
}

export async function revokeAllUserSessions(db: Database, userId: string, reason: string): Promise<string[]> {
  const active = await db.query.sessions.findMany({ where: and(eq(sessions.userId, userId), isNull(sessions.revokedAt)) });
  await db.update(sessions).set({ revokedAt: new Date(), revokedReason: reason }).where(eq(sessions.userId, userId));
  return active.map((s) => s.id);
}

/** Bumps `users.row_version` (any UPDATE fires the `bump_row_version`
 * trigger) so every previously-issued access token's `ver` claim goes stale
 * immediately — the enforcement half of force-logout / password-change /
 * disable-2FA session invalidation (see plugins/auth.ts). */
export async function bumpUserVersion(db: Database, userId: string): Promise<number> {
  // `set_updated_at` always overwrites this to now() regardless of the value
  // given — the point of this call is only to trigger an UPDATE so
  // `bump_row_version` fires.
  const [row] = await db.update(users).set({ updatedAt: new Date() }).where(eq(users.id, userId)).returning({ rowVersion: users.rowVersion });
  return row?.rowVersion ?? 0;
}

export async function insertRecoveryCodes(db: Database, userId: string, codeHashes: string[]): Promise<void> {
  if (codeHashes.length === 0) return;
  await db.insert(totpRecoveryCodes).values(codeHashes.map((codeHash) => ({ id: newId(), userId, codeHash })));
}

export async function findUnusedRecoveryCodes(db: Database, userId: string) {
  return db.query.totpRecoveryCodes.findMany({ where: and(eq(totpRecoveryCodes.userId, userId), isNull(totpRecoveryCodes.usedAt)) });
}

export async function consumeRecoveryCode(db: Database, id: string): Promise<void> {
  await db.update(totpRecoveryCodes).set({ usedAt: new Date() }).where(eq(totpRecoveryCodes.id, id));
}

export async function deleteAllRecoveryCodes(db: Database, userId: string): Promise<void> {
  // totp_recovery_codes has no soft-delete column (single-use ephemeral
  // tokens); marking every unused code as used is the "delete" here.
  const rows = await findUnusedRecoveryCodes(db, userId);
  for (const row of rows) {
    await consumeRecoveryCode(db, row.id);
  }
}
