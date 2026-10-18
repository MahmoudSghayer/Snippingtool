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

/** A Drizzle transaction handle (what `db.transaction(cb)` passes `cb`). */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

export type SessionRow = typeof sessions.$inferSelect;

export async function findUserByEmail(db: Database, email: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: and(eq(users.email, email), isNull(users.deletedAt)) });
}

export async function findUserById(db: Database, id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: and(eq(users.id, id), isNull(users.deletedAt)) });
}

export async function createEmailVerification(
  db: Database,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(emailVerifications).values({ id: newId(), userId, tokenHash, expiresAt });
}

export async function findValidEmailVerification(db: Database, tokenHash: string) {
  return db.query.emailVerifications.findFirst({
    where: and(eq(emailVerifications.tokenHash, tokenHash), isNull(emailVerifications.consumedAt)),
  });
}

export async function consumeEmailVerification(db: Database, id: string): Promise<void> {
  await db
    .update(emailVerifications)
    .set({ consumedAt: new Date() })
    .where(eq(emailVerifications.id, id));
}

export async function createPasswordReset(
  db: Database,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
  ip: string | null,
): Promise<void> {
  await db
    .insert(passwordResets)
    .values({ id: newId(), userId, tokenHash, expiresAt, requestedIp: ip });
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
  db: Executor,
  params: {
    userId: string;
    deviceId: string | null;
    refreshTokenHash: string;
    familyId: string;
    ip: string | null;
    userAgent: string | null;
    expiresAt: Date;
  },
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

/** `revoked_reason` of a row whose token was rotated by a refresh. */
export const ROTATED = 'rotated';
/** `revoked_reason` of a row `reissueWithinGrace` replaced. Never eligible
 * for the grace itself: presenting such a token is always reuse. */
export const RETRY_SUPERSEDED = 'retry_superseded';

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
 *
 * The revoke is conditional (`revoked_at IS NULL`): two refreshes racing on
 * the same token both read it as live, but only one UPDATE can match. The
 * loser gets `null` back (service.ts `refresh` answers it
 * `AUTH_REFRESH_CONFLICT`, revoking nothing).
 *
 * The revoke and the insert are one transaction, so nobody ever sees the
 * family with its old head revoked and no new head yet: `reissueWithinGrace`
 * below reads "no live row" as "this family was revoked".
 */
export async function rotateSession(
  db: Database,
  previous: {
    id: string;
    userId: string;
    deviceId: string | null;
    familyId: string;
    ip: string | null;
    userAgent: string | null;
  },
  newRefreshTokenHash: string,
  expiresAt: Date,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: ROTATED })
      .where(and(eq(sessions.id, previous.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (!revoked) return null;
    return createSession(tx, {
      userId: previous.userId,
      deviceId: previous.deviceId,
      refreshTokenHash: newRefreshTokenHash,
      familyId: previous.familyId,
      ip: previous.ip,
      userAgent: previous.userAgent,
      expiresAt,
    });
  });
}

export type GraceReissue =
  | { kind: 'reissued'; sessionId: string }
  /** Not a benign retry: the caller treats it as reuse. */
  | { kind: 'not_eligible' }
  /** Another request changed the family's head meanwhile; nothing was
   * written. */
  | { kind: 'conflict' };

/**
 * The refresh grace (docs/04-auth.md §3): `presented` is a session row whose
 * token was rotated moments ago, presented again — what a client does when
 * the answer to its first refresh was lost (a 502 during a deploy, a dropped
 * connection). The server only keeps token hashes, so it cannot hand back
 * the successor it already issued; instead the successor is retired
 * (`retry_superseded`) and a new row is minted in the same family, with the
 * new token's hash. The family still has exactly one live row.
 *
 * Eligible only when all of these hold, read fresh inside the transaction:
 *  - `presented` was revoked as `rotated` (not by a logout, a password
 *    change, an admin, a ban or reuse detection: every family- or user-wide
 *    revocation overwrites the reason on every row, so a revoked family
 *    never reads as `rotated`), and no more than `graceMs` ago;
 *  - the family has exactly one live, unexpired row (its head): no live
 *    row means the family was revoked, and it is never revived;
 *  - every row revoked since `presented` was rotated was retired by this
 *    function, never rotated: the head is `presented`'s own successor (or a
 *    re-issue of it), which nobody has used to refresh. A successor that was
 *    used proves the first answer arrived, so `presented` is being replayed.
 *    (Timestamps compare with `>=`: a tie reads as "used", the strict side.)
 * The head's retirement is conditional on it still being live, so of two
 * concurrent retries only one re-issues; the other gets `conflict`.
 */
export async function reissueWithinGrace(
  db: Database,
  presented: SessionRow,
  newRefreshTokenHash: string,
  expiresAt: Date,
  now: Date,
  graceMs: number,
): Promise<GraceReissue> {
  return db.transaction(async (tx): Promise<GraceReissue> => {
    const family = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.familyId, presented.familyId));
    const self = family.find((row) => row.id === presented.id);
    const rotatedAt = self?.revokedAt;
    if (!self || !rotatedAt || self.revokedReason !== ROTATED) return { kind: 'not_eligible' };
    if (now.getTime() - rotatedAt.getTime() > graceMs) return { kind: 'not_eligible' };

    const live = family.filter((row) => row.revokedAt === null);
    const head = live.length === 1 ? live[0] : undefined;
    if (!head || head.expiresAt.getTime() <= now.getTime()) return { kind: 'not_eligible' };

    const usedSince = family.some(
      (row) =>
        row.id !== self.id &&
        row.revokedAt !== null &&
        row.revokedAt.getTime() >= rotatedAt.getTime() &&
        row.revokedReason !== RETRY_SUPERSEDED,
    );
    if (usedSince) return { kind: 'not_eligible' };

    const [retired] = await tx
      .update(sessions)
      .set({ revokedAt: now, revokedReason: RETRY_SUPERSEDED })
      .where(and(eq(sessions.id, head.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (!retired) return { kind: 'conflict' };

    const sessionId = await createSession(tx, {
      userId: head.userId,
      deviceId: head.deviceId,
      refreshTokenHash: newRefreshTokenHash,
      familyId: head.familyId,
      ip: head.ip,
      userAgent: head.userAgent,
      expiresAt,
    });
    return { kind: 'reissued', sessionId };
  });
}

export async function revokeSession(
  db: Database,
  sessionId: string,
  reason: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(sessions.id, sessionId));
}

export async function revokeSessionFamily(
  db: Database,
  familyId: string,
  reason: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(sessions.familyId, familyId));
}

export async function revokeAllUserSessions(
  db: Database,
  userId: string,
  reason: string,
): Promise<string[]> {
  const active = await db.query.sessions.findMany({
    where: and(eq(sessions.userId, userId), isNull(sessions.revokedAt)),
  });
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(sessions.userId, userId));
  return active.map((s) => s.id);
}

/** Every session id this user has ever had, revoked or not — used only to
 * pick WS event targets, never to decide what to revoke in the DB (that's
 * `revokeAllUserSessions`, which correctly no-ops on an already-revoked
 * row). Defect #7 fix (docs/12-testing.md "Defects found"): `force-logout`
 * calling `revokeAllUserSessions` a second time after `suspend` already
 * revoked every session finds nothing newly-revoked (an empty return),
 * so it had nothing to `publishToUser(..., 'session.revoked', ...)` for —
 * a silent no-op from the *notification's* point of view, even though the
 * admin's force-logout action did happen. Falling back to this list lets
 * the route still notify any live WS connection for the user regardless of
 * whether the DB-level revoke was a no-op this time. */
export async function listAllUserSessionIds(db: Database, userId: string): Promise<string[]> {
  const all = await db.query.sessions.findMany({
    where: eq(sessions.userId, userId),
    columns: { id: true },
  });
  return all.map((s) => s.id);
}

/** Bumps `users.row_version` (any UPDATE fires the `bump_row_version`
 * trigger) so every previously-issued access token's `ver` claim goes stale
 * immediately — the enforcement half of force-logout / password-change /
 * disable-2FA session invalidation (see plugins/auth.ts). */
export async function bumpUserVersion(db: Database, userId: string): Promise<number> {
  // `set_updated_at` always overwrites this to now() regardless of the value
  // given — the point of this call is only to trigger an UPDATE so
  // `bump_row_version` fires.
  const [row] = await db
    .update(users)
    .set({ updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ rowVersion: users.rowVersion });
  return row?.rowVersion ?? 0;
}

export async function insertRecoveryCodes(
  db: Database,
  userId: string,
  codeHashes: string[],
): Promise<void> {
  if (codeHashes.length === 0) return;
  await db
    .insert(totpRecoveryCodes)
    .values(codeHashes.map((codeHash) => ({ id: newId(), userId, codeHash })));
}

export async function findUnusedRecoveryCodes(db: Database, userId: string) {
  return db.query.totpRecoveryCodes.findMany({
    where: and(eq(totpRecoveryCodes.userId, userId), isNull(totpRecoveryCodes.usedAt)),
  });
}

export async function consumeRecoveryCode(db: Database, id: string): Promise<void> {
  await db
    .update(totpRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(eq(totpRecoveryCodes.id, id));
}

export async function deleteAllRecoveryCodes(db: Database, userId: string): Promise<void> {
  // totp_recovery_codes has no soft-delete column (single-use ephemeral
  // tokens); marking every unused code as used is the "delete" here.
  const rows = await findUnusedRecoveryCodes(db, userId);
  for (const row of rows) {
    await consumeRecoveryCode(db, row.id);
  }
}
