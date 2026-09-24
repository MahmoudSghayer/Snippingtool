// Ban creation/lifting and the ban checks the auth module runs at login
// (`checkBans`) and on every authenticated request (`isRequestBanned`)
// (docs/05-subscriptions.md §8, "Cross-agent touchpoints").
//
// A ban takes effect immediately, without waiting for tokens to expire:
//   - account: every session is revoked (with a `session.revoked` WS push)
//     and `users.row_version` is bumped, which invalidates every access
//     token already issued (plugins/auth.ts compares it on each request).
//   - device: every session opened from a device with that fingerprint is
//     revoked the same way.
//   - ip: `isRequestBanned` rejects any request from that address, cached
//     per (user, ip) in Redis under a generation counter that every ban and
//     lift bumps, so a new ban is never hidden behind a cached "not banned".
//   - hwid: only known at login, so it is enforced by `checkBans` there.
// `users.status` is left alone: suspension is admin-users' concern, and a
// lifted ban must not have to remember what status to restore.

import { bans, devices, sessions, type Database } from '@sl/db';
import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { publishToUser } from '../../ws/publish.js';
import { bumpUserVersion } from '../auth/repo.js';

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
  return revokeSessions(db, redis, and(eq(sessions.userId, userId), isNull(sessions.revokedAt))!);
}

async function revokeSessions(db: Database, redis: Redis, where: SQL): Promise<number> {
  const activeSessions = await db.query.sessions.findMany({ where });
  for (const session of activeSessions) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'admin_force_logout' })
      .where(eq(sessions.id, session.id));
    await publishToUser(redis, session.userId, {
      type: 'session.revoked',
      sessionId: session.id,
      reason: 'admin_force_logout',
    });
  }
  return activeSessions.length;
}

const BAN_GENERATION_KEY = 'bans:generation';
const BAN_CHECK_TTL_SECONDS = 60;

async function bumpBanGeneration(redis: Redis): Promise<void> {
  await redis.incr(BAN_GENERATION_KEY);
}

/** Per-request ban check for an already-authenticated caller: the account
 * and the request's IP. Cached for a minute per (user, ip); any ban or lift
 * bumps the generation in the cache key, so a change applies on the very
 * next request. */
export async function isRequestBanned(
  db: Database,
  redis: Redis,
  input: { userId: string; ip: string },
): Promise<boolean> {
  const generation = (await redis.get(BAN_GENERATION_KEY)) ?? '0';
  const key = `bans:check:${generation}:${input.userId}:${input.ip}`;
  const cached = await redis.get(key);
  if (cached !== null) return cached === '1';

  const { banned } = await checkBans(db, { userId: input.userId, ip: input.ip });
  await redis.set(key, banned ? '1' : '0', 'EX', BAN_CHECK_TTL_SECONDS);
  return banned;
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
    await bumpUserVersion(db, input.userId);
  } else if (input.type === 'device') {
    const bannedDevices = await db.query.devices.findMany({
      columns: { id: true },
      where: eq(devices.fingerprintHash, input.value),
    });
    if (bannedDevices.length > 0) {
      await revokeSessions(
        db,
        redis,
        and(
          inArray(
            sessions.deviceId,
            bannedDevices.map((d) => d.id),
          ),
          isNull(sessions.revokedAt),
        )!,
      );
    }
  }
  await bumpBanGeneration(redis);

  return row!;
}

export async function liftBan(db: Database, redis: Redis, banId: string): Promise<BanRow> {
  const existing = await db.query.bans.findFirst({ where: eq(bans.id, banId) });
  if (!existing) throw AppErrors.notFound('ban');
  if (existing.liftedAt) throw AppErrors.conflict('Ban is already lifted.');

  const [row] = await db
    .update(bans)
    .set({ liftedAt: new Date() })
    .where(eq(bans.id, banId))
    .returning();
  await bumpBanGeneration(redis);
  return row!;
}

export async function listBans(db: Database, filter: { active?: boolean } = {}): Promise<BanRow[]> {
  return db.query.bans.findMany({
    where: filter.active ? isNull(bans.liftedAt) : undefined,
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}
