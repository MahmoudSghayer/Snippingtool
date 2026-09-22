// Login protection: (1) a Redis sliding-window rate limit per key (IP or
// account), and (2) DB-backed account lockout (`users.failed_login_count` /
// `locked_until`) with exponential backoff after 5 consecutive failures.
// Both apply independently — the rate limit throttles *attempts*
// (regardless of which account), the lockout protects one *account*
// specifically even from a rotating-IP attacker.

import { users, type Database } from '@sl/db';
import { eq } from 'drizzle-orm';

import { AppErrors } from './errors.js';

import type { Redis } from 'ioredis';

const BASE_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCKOUT_THRESHOLD = 5;

/** Sliding-window counter via a Redis sorted set: members are unique
 * per-attempt tokens scored by timestamp; stale members outside the window
 * are trimmed on every check. Throws RATE_LIMITED if the window is full. */
export async function checkSlidingWindowRateLimit(
  redis: Redis,
  key: string,
  max: number,
  windowMs: number,
): Promise<void> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const member = `${now}:${Math.random().toString(36).slice(2)}`;

  const pipeline = redis.multi();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, member);
  pipeline.zcard(key);
  pipeline.pexpire(key, windowMs);
  const results = await pipeline.exec();

  const count = (results?.[2]?.[1] as number | undefined) ?? 0;
  if (count > max) {
    throw AppErrors.rateLimited(Math.ceil(windowMs / 1000));
  }
}

/** Throws AUTH_ACCOUNT_LOCKED if the account is currently locked out. Call
 * before verifying the password. */
export function assertNotLocked(lockedUntil: Date | null): void {
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    throw AppErrors.accountLocked(Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
  }
}

/** Records a failed login attempt: increments `failed_login_count`, and once
 * the threshold is crossed, sets `locked_until` with exponential backoff
 * (15m, 30m, 60m, ... capped at 24h). */
export async function recordFailedLogin(
  db: Database,
  userId: string,
  currentFailedCount: number,
): Promise<void> {
  const failedCount = currentFailedCount + 1;
  let lockedUntil: Date | null = null;
  if (failedCount >= LOCKOUT_THRESHOLD) {
    const backoffMultiplier = 2 ** (failedCount - LOCKOUT_THRESHOLD);
    const lockoutMs = Math.min(BASE_LOCKOUT_MS * backoffMultiplier, MAX_LOCKOUT_MS);
    lockedUntil = new Date(Date.now() + lockoutMs);
  }
  await db
    .update(users)
    .set({ failedLoginCount: failedCount, lockedUntil })
    .where(eq(users.id, userId));
}

export async function resetLoginFailures(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, userId));
}
