// Online-user presence, backed by Redis: a set `presence:online` of userIds
// plus a per-user TTL key `presence:user:<id>` that a connected WS client
// refreshes every 20s. `presence.sweep` (jobs/presence.sweep.job.ts) removes
// stale entries whose TTL key has already expired but whose set membership
// survived an ungraceful disconnect (crash, network drop with no close
// frame).

import type { Redis } from 'ioredis';

const ONLINE_SET = 'presence:online';
const PRESENCE_TTL_SECONDS = 45;

function presenceKey(userId: string): string {
  return `presence:user:${userId}`;
}

export async function markOnline(redis: Redis, userId: string): Promise<void> {
  await redis.multi().sadd(ONLINE_SET, userId).set(presenceKey(userId), '1', 'EX', PRESENCE_TTL_SECONDS).exec();
}

export async function touchPresence(redis: Redis, userId: string): Promise<void> {
  await redis.set(presenceKey(userId), '1', 'EX', PRESENCE_TTL_SECONDS);
}

export async function markOffline(redis: Redis, userId: string): Promise<void> {
  await redis.multi().srem(ONLINE_SET, userId).del(presenceKey(userId)).exec();
}

export async function countOnline(redis: Redis): Promise<number> {
  return redis.scard(ONLINE_SET);
}

/** Removes stale members: online-set entries whose TTL key has expired.
 * Called by the presence.sweep job on a schedule. Returns the number
 * removed. */
export async function sweepStalePresence(redis: Redis): Promise<number> {
  const members = await redis.smembers(ONLINE_SET);
  if (members.length === 0) return 0;
  let removed = 0;
  for (const userId of members) {
    const exists = await redis.exists(presenceKey(userId));
    if (!exists) {
      await redis.srem(ONLINE_SET, userId);
      removed++;
    }
  }
  return removed;
}
