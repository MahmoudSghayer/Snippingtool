// Ban creation/lifting and the `checkBans()` seam the auth module's login
// path calls (docs/05-subscriptions.md §8, "Cross-agent touchpoints").
//
// Deliberately does NOT touch `users.status`/`users.row_version` — those are
// the core agent's `users`/`admin-users` modules' territory. A ban's effect
// is enforced two ways instead: (1) every active session is revoked + a
// `session.revoked` WS push is sent immediately, and (2) `checkBans()` is
// exported for the auth module to call at login time (and optionally on
// every authenticated request) so a banned identity — account, IP, device
// fingerprint, or hwid — is rejected regardless of whether a still-valid
// access token exists.

import { bans, sessions, type Database } from '@sl/db';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { publishToUser } from '../../ws/publish.js';

import type { Redis } from 'ioredis';

export type BanRow = typeof bans.$inferSelect;

export interface CheckBansInput {
  userId?: string | null;
  ip?: string | null;
  deviceFingerprintHash?: string | null;
  hwid?: string | null;
}

/** Checks every identifier the caller has available against live
 * (`lifted_at IS NULL`) bans, honouring `expires_at`. Returns the
 * first matching ban (there is no meaningful "most severe" ordering across
 * ban types — any live match is a hard block). */
export async function checkBans(
  db: Database,
  input: CheckBansInput,
): Promise<{ banned: boolean; ban: BanRow | null }> {
  const conditions: SQL[] = [];
  if (input.userId) conditions.push(and(eq(bans.type, 'account'), eq(bans.userId, input.userId))!);
  if (input.ip) conditions.push(and(eq(bans.type, 'ip'), eq(bans.value, input.ip))!);
  if (input.deviceFingerprintHash)
    conditions.push(and(eq(bans.type, 'device'), eq(bans.value, input.deviceFingerprintHash))!);
  if (input.hwid) conditions.push(and(eq(bans.type, 'hwid'), eq(bans.value, input.hwid))!);
  if (conditions.length === 0) return { banned: false, ban: null };

  const rows = await db.query.bans.findMany({
    where: and(isNull(bans.liftedAt), or(...conditions)),
  });
  const now = Date.now();
  const active = rows.find((r) => r.expiresAt === null || r.expiresAt.getTime() > now);
  return active ? { banned: true, ban: active } : { banned: false, ban: null };
}

/** Revokes every currently-active session for a user and pushes
 * `session.revoked` for each — called for an `account`-type ban. */
export async function revokeAllSessionsForBan(
  db: Database,
  redis: Redis,
  userId: string,
): Promise<number> {
  const activeSessions = await db.query.sessions.findMany({
    where: and(eq(sessions.userId, userId), isNull(sessions.revokedAt)),
  });
  for (const session of activeSessions) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'admin_force_logout' })
      .where(eq(sessions.id, session.id));
    await publishToUser(redis, userId, {
      type: 'session.revoked',
      sessionId: session.id,
      reason: 'admin_force_logout',
    });
  }
  return activeSessions.length;
}

export interface CreateBanInput {
  type: BanRow['type'];
  value: string;
  userId: string | null;
  reason: string;
  issuedBy: string | null;
  expiresAt: Date | null;
}

export async function createBan(
  db: Database,
  redis: Redis,
  input: CreateBanInput,
): Promise<BanRow> {
  if (input.type === 'account' && !input.userId) {
    throw AppErrors.validation('userId is required for an account ban.');
  }

  const [row] = await db
    .insert(bans)
    .values({
      id: newId(),
      userId: input.userId,
      type: input.type,
      value: input.type === 'account' ? '' : input.value,
      reason: input.reason,
      issuedBy: input.issuedBy,
      expiresAt: input.expiresAt,
    })
    .returning();

  if (input.type === 'account' && input.userId) {
    await revokeAllSessionsForBan(db, redis, input.userId);
  }

  return row!;
}

export async function liftBan(db: Database, banId: string): Promise<BanRow> {
  const existing = await db.query.bans.findFirst({ where: eq(bans.id, banId) });
  if (!existing) throw AppErrors.notFound('ban');
  if (existing.liftedAt) throw AppErrors.conflict('Ban is already lifted.');

  const [row] = await db
    .update(bans)
    .set({ liftedAt: new Date() })
    .where(eq(bans.id, banId))
    .returning();
  return row!;
}

export async function listBans(db: Database, filter: { active?: boolean } = {}): Promise<BanRow[]> {
  return db.query.bans.findMany({
    where: filter.active ? isNull(bans.liftedAt) : undefined,
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}
