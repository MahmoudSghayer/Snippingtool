// Online-user presence, backed by Redis: a set `presence:online` of userIds
// plus a per-user TTL key `presence:user:<id>` that a connected WS client
// refreshes every 20s. The key holds the user's number of open connections
// (dashboard tabs, the extension), so closing one of them leaves the user
// online while another is still connected. `presence.sweep` (jobs/presence.sweep.job.ts) removes
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
  await redis
    .multi()
    .sadd(ONLINE_SET, userId)
    .incr(presenceKey(userId))
    .expire(presenceKey(userId), PRESENCE_TTL_SECONDS)
    .exec();
}

// Refreshes the TTL without touching the count. If the key already expired
// (a stalled event loop, a sweep in between), the connection re-registers
// itself as one.
const TOUCH_SCRIPT = `
if redis.call('EXPIRE', KEYS[1], ARGV[1]) == 0 then
  redis.call('SET', KEYS[1], 1, 'EX', ARGV[1])
  redis.call('SADD', KEYS[2], ARGV[2])
end
return 1`;

export async function touchPresence(redis: Redis, userId: string): Promise<void> {
  await redis.eval(TOUCH_SCRIPT, 2, presenceKey(userId), ONLINE_SET, PRESENCE_TTL_SECONDS, userId);
}

// Decrement and, at zero, leave the online set, as one atomic step — a
// separate DECR then SREM would let a connection opening in between be
// removed right after it registered.
const OFFLINE_SCRIPT = `
local n = redis.call('DECR', KEYS[1])
if n <= 0 then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[1])
end
return n`;

export async function markOffline(redis: Redis, userId: string): Promise<void> {
  await redis.eval(OFFLINE_SCRIPT, 2, presenceKey(userId), ONLINE_SET, userId);
}

export async function countOnline(redis: Redis): Promise<number> {
  return redis.scard(ONLINE_SET);
}

const SCAN_BATCH_SIZE = 200;

/** Iterates every online user id in batches via `SSCAN` (never `SMEMBERS`,
 * which would pull the whole online set into memory in one round trip) —
 * for fan-out sends (e.g. admin-toggles' kill-switch broadcast) that need
 * to reach every currently-online user without loading the whole set at
 * once. Best-effort/eventually-consistent like `SSCAN` itself: a user who
 * connects or disconnects mid-scan may or may not be included, which is
 * fine for a broadcast (a client that connects moments later gets the
 * current state on its own initial bootstrap/heartbeat anyway). */
export async function* scanOnlineUserIds(
  redis: Redis,
  batchSize: number = SCAN_BATCH_SIZE,
): AsyncGenerator<string[]> {
  let cursor = '0';
  do {
    const [nextCursor, members] = await redis.sscan(ONLINE_SET, cursor, 'COUNT', batchSize);
    cursor = nextCursor;
    if (members.length > 0) yield members;
  } while (cursor !== '0');
}

/** Removes stale members: online-set entries whose TTL key has expired.
 * Called by the presence.sweep job on a schedule. Returns the number
 * removed. */
export async function sweepStalePresence(redis: Redis): Promise<number> {
  let removed = 0;
  for await (const batch of scanOnlineUserIds(redis)) {
    const pipeline = redis.pipeline();
    for (const userId of batch) pipeline.exists(presenceKey(userId));
    const results = (await pipeline.exec()) ?? [];
    const stale = batch.filter((_, i) => results[i]?.[1] === 0);
    if (stale.length > 0) removed += await redis.srem(ONLINE_SET, ...stale);
  }
  return removed;
}
