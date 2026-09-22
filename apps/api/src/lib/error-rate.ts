// A minute-bucketed error counter in Redis, read by admin-system's health
// endpoint ("error rate from a Redis counter" per the PHASE 3 spec). Each
// bucket auto-expires after 10 minutes so old data never needs sweeping.

import type { Redis } from 'ioredis';

function bucketKey(epochMinute: number): string {
  return `metrics:errors:${epochMinute}`;
}

export async function recordError(redis: Redis): Promise<void> {
  const epochMinute = Math.floor(Date.now() / 60_000);
  const key = bucketKey(epochMinute);
  await redis.multi().incr(key).expire(key, 600).exec();
}

/** Total 5xx responses across the last `minutes` one-minute buckets. */
export async function getErrorRate(redis: Redis, minutes = 5): Promise<number> {
  const now = Math.floor(Date.now() / 60_000);
  const keys = Array.from({ length: minutes }, (_, i) => bucketKey(now - i));
  const values = await redis.mget(...keys);
  return values.reduce((sum: number, v) => sum + (v ? Number(v) : 0), 0);
}
