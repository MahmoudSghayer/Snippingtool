// `admin.overview.tick`: the live counters on /admin (Overview) — online
// users, snipe attempts and extension errors in the last minute — pushed
// to every connected admin on `ADMIN_CHANNEL` (modules/ws subscribes admin
// sockets to it) by plugins/admin-overview-tick.ts every
// `ADMIN_TICK_INTERVAL_MS`.

import { snipingActivity, userActivity, type Database } from '@sl/db';
import { and, count, eq, gte } from 'drizzle-orm';

import { countOnline } from './presence.js';
import { ADMIN_CHANNEL, publishAdmin } from './publish.js';

import type { WsEvent } from '@sl/shared';
import type { Redis } from 'ioredis';

export type AdminOverviewTick = Extract<WsEvent, { type: 'admin.overview.tick' }>;

export const ADMIN_TICK_INTERVAL_MS = 10_000;

/** The "last minute" the two activity counters cover. */
export const TICK_WINDOW_MS = 60_000;

/** Rows that happened longer ago than this are left out of the live
 * counters even when they only arrive now (an offline queue flushed late is
 * not live activity). Also bounds the scan to the newest partition pages
 * (both tables have a BRIN index on occurred_at). */
export const TICK_LATE_ARRIVAL_MS = 10 * 60_000;

/** One instance per tick computes and publishes (SET NX); the others skip.
 * The payload is idempotent, so a duplicate after a lock expiry is harmless. */
export const TICK_LOCK_KEY = 'ws:admin:overview:tick-lock';

/**
 * The counters, as of `now`:
 *
 * - `onlineUsers`: `countOnline` (WS presence set), the same number the
 *   System page's "WS online users" shows.
 * - `activeSnipesLastMinute`: `sniping_activity` rows (buy attempts, every
 *   outcome) **received** in the last minute.
 * - `errorsLastMinute`: `user_activity` rows of type `error` (the
 *   extension's error reports, the rows /admin/activity's Errors tab lists)
 *   **received** in the last minute. API 5xx responses are a different
 *   number: the System page's Redis counter (lib/error-rate.ts).
 *
 * "Received" = `created_at`, not `occurred_at`: the extension uploads
 * attempts in batches every 2 minutes and error reports every 5, so a
 * window on `occurred_at` would read 0 almost every tick and only count
 * the minute after the fact. Rows whose `occurred_at` is older than
 * `TICK_LATE_ARRIVAL_MS` are excluded.
 */
export async function computeAdminOverviewTick(
  db: Database,
  redis: Redis,
  now: Date = new Date(),
): Promise<AdminOverviewTick> {
  const receivedSince = new Date(now.getTime() - TICK_WINDOW_MS);
  const occurredSince = new Date(now.getTime() - TICK_LATE_ARRIVAL_MS);

  const [onlineUsers, [snipes], [errors]] = await Promise.all([
    countOnline(redis),
    db
      .select({ n: count() })
      .from(snipingActivity)
      .where(
        and(
          gte(snipingActivity.occurredAt, occurredSince),
          gte(snipingActivity.createdAt, receivedSince),
        ),
      ),
    db
      .select({ n: count() })
      .from(userActivity)
      .where(
        and(
          eq(userActivity.type, 'error'),
          gte(userActivity.occurredAt, occurredSince),
          gte(userActivity.createdAt, receivedSince),
        ),
      ),
  ]);

  return {
    type: 'admin.overview.tick',
    onlineUsers,
    activeSnipesLastMinute: snipes?.n ?? 0,
    errorsLastMinute: errors?.n ?? 0,
    generatedAt: now.toISOString(),
  };
}

/** Subscribers to `ADMIN_CHANNEL` across every API instance (PUBSUB
 * NUMSUB): with no admin connected there is nothing to compute. */
async function adminSubscriberCount(redis: Redis): Promise<number> {
  const reply = (await redis.pubsub('NUMSUB', ADMIN_CHANNEL)) as unknown[];
  return Number(reply[1] ?? 0);
}

export type TickOutcome = 'published' | 'no-subscribers' | 'locked';

/** One tick: skipped when no admin is listening or another instance holds
 * this interval's lock, otherwise computed and published. */
export async function publishAdminOverviewTick(
  db: Database,
  redis: Redis,
  options: { intervalMs?: number; now?: Date } = {},
): Promise<TickOutcome> {
  if ((await adminSubscriberCount(redis)) === 0) return 'no-subscribers';

  // Held for a little less than one interval, so the next tick (on any
  // instance) always finds it free.
  const intervalMs = options.intervalMs ?? ADMIN_TICK_INTERVAL_MS;
  const lockMs = Math.max(1, intervalMs - Math.min(1_000, Math.floor(intervalMs / 2)));
  const acquired = await redis.set(TICK_LOCK_KEY, '1', 'PX', lockMs, 'NX');
  if (!acquired) return 'locked';

  await publishAdmin(redis, await computeAdminOverviewTick(db, redis, options.now));
  return 'published';
}
