// Presence counts connections per user: a user with the dashboard and the
// extension both connected stays online when one of them closes.

import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

import { newId } from '../../lib/ids.js';
import { markOffline, markOnline, sweepStalePresence, touchPresence } from '../presence.js';

import 'dotenv/config';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  db: Number(process.env.REDIS_TEST_DB ?? 15),
});

async function isOnline(userId: string): Promise<boolean> {
  return (await redis.sismember('presence:online', userId)) === 1;
}

describe('ws/presence', () => {
  afterAll(() => {
    redis.disconnect();
  });

  it('stays online until the last of several connections closes', async () => {
    const userId = newId();
    await markOnline(redis, userId);
    await markOnline(redis, userId);

    await markOffline(redis, userId);
    expect(await isOnline(userId)).toBe(true);

    await markOffline(redis, userId);
    expect(await isOnline(userId)).toBe(false);
    expect(await redis.exists(`presence:user:${userId}`)).toBe(0);
  });

  it('a touch keeps the connection count instead of resetting it', async () => {
    const userId = newId();
    await markOnline(redis, userId);
    await markOnline(redis, userId);
    await touchPresence(redis, userId);

    await markOffline(redis, userId);
    expect(await isOnline(userId)).toBe(true);
    await markOffline(redis, userId);
    expect(await isOnline(userId)).toBe(false);
  });

  it('a touch after the key expired re-registers the connection', async () => {
    const userId = newId();
    await markOnline(redis, userId);
    await redis.del(`presence:user:${userId}`);
    await redis.srem('presence:online', userId);

    await touchPresence(redis, userId);
    expect(await isOnline(userId)).toBe(true);
    await markOffline(redis, userId);
    expect(await isOnline(userId)).toBe(false);
  });

  it('the sweep removes users whose presence key expired, and only them', async () => {
    const live = newId();
    const stale = newId();
    await markOnline(redis, live);
    await markOnline(redis, stale);
    await redis.del(`presence:user:${stale}`);

    expect(await sweepStalePresence(redis)).toBeGreaterThanOrEqual(1);
    expect(await isOnline(live)).toBe(true);
    expect(await isOnline(stale)).toBe(false);
    await markOffline(redis, live);
  });
});
