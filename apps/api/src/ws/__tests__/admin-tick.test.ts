// admin.overview.tick: what the counters count, when a tick is skipped, and
// that the plugin really publishes on ADMIN_CHANNEL once a test opts in.

import { snipingActivity, userActivity, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { wsEventSchema } from '@sl/shared';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { newId } from '../../lib/ids.js';
import {
  TICK_LOCK_KEY,
  computeAdminOverviewTick,
  publishAdminOverviewTick,
} from '../admin-tick.js';
import { markOffline, markOnline } from '../presence.js';
import { ADMIN_CHANNEL } from '../publish.js';

import type { FastifyInstance } from 'fastify';

async function createUser(app: FastifyInstance): Promise<string> {
  const id = newId();
  await app.db
    .insert(users)
    .values({ id, email: `${id}@example.com`, passwordHash: 'x', emailVerifiedAt: new Date() });
  return id;
}

function snipe(userId: string, occurredAt: Date, createdAt?: Date) {
  return {
    id: newId(),
    userId,
    resourceId: '67123',
    targetPrice: 1000,
    outcome: 'attempted' as const,
    occurredAt,
    ...(createdAt ? { createdAt } : {}),
  };
}

/** A pub/sub connection on ADMIN_CHANNEL, collecting what arrives. */
async function subscribeAdmin(url: string) {
  const sub = new Redis(url);
  const messages: unknown[] = [];
  sub.on('message', (channel: string, message: string) => {
    if (channel === ADMIN_CHANNEL) messages.push(JSON.parse(message));
  });
  await sub.subscribe(ADMIN_CHANNEL);
  return { messages, close: () => sub.disconnect() };
}

describe('ws/admin-tick', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await app.redis.del(TICK_LOCK_KEY);
  });

  it('counts online users, attempts and extension errors received in the last minute', async () => {
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const userId = await createUser(app);
    const onlineId = newId();
    await markOnline(app.redis, onlineId);

    await app.db.insert(snipingActivity).values([
      snipe(userId, ago(30_000)), // happened and arrived just now
      snipe(userId, ago(100_000)), // happened 100 s ago, arrived in the last batch: counts
      snipe(userId, ago(120_000), ago(90_000)), // arrived 90 s ago: not this minute
      snipe(userId, ago(20 * 60_000)), // an old offline queue flushed now: not live
    ]);
    await app.db.insert(userActivity).values([
      {
        id: newId(),
        userId,
        type: 'error',
        metadata: { message: 'boom' },
        occurredAt: ago(200_000),
      },
      { id: newId(), userId, type: 'heartbeat', metadata: {}, occurredAt: ago(1_000) }, // not an error
      {
        id: newId(),
        userId,
        type: 'error',
        metadata: { message: 'older' },
        occurredAt: ago(300_000),
        createdAt: ago(120_000),
      },
    ]);

    const tick = await computeAdminOverviewTick(app.db, app.redis, now);
    expect(wsEventSchema.parse(tick)).toEqual(tick);
    expect(tick).toMatchObject({
      type: 'admin.overview.tick',
      activeSnipesLastMinute: 2,
      errorsLastMinute: 1,
      generatedAt: now.toISOString(),
    });
    expect(tick.onlineUsers).toBeGreaterThanOrEqual(1);
    await markOffline(app.redis, onlineId);
  });

  it('skips a tick nobody listens to, publishes when an admin is subscribed, and takes the lock once per interval', async () => {
    expect(await publishAdminOverviewTick(app.db, app.redis)).toBe('no-subscribers');

    const sub = await subscribeAdmin(app.config.REDIS_URL);
    try {
      expect(await publishAdminOverviewTick(app.db, app.redis)).toBe('published');
      // Another instance's timer firing in the same interval does nothing.
      expect(await publishAdminOverviewTick(app.db, app.redis)).toBe('locked');

      await expect.poll(() => sub.messages.length).toBe(1);
      expect(wsEventSchema.parse(sub.messages[0]).type).toBe('admin.overview.tick');
    } finally {
      sub.close();
    }
  });

  describe('plugin', () => {
    let ticking: FastifyInstance | undefined;

    afterEach(async () => {
      await ticking?.close();
      ticking = undefined;
    });

    it('is off in tests by default and publishes on its interval once enabled', async () => {
      const sub = await subscribeAdmin(app.config.REDIS_URL);
      try {
        // `app` (default options) has been ready all along without a tick.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(sub.messages).toHaveLength(0);

        ticking = await buildApp({
          logger: false,
          skipModuleAutoload: true,
          adminOverviewTick: { enabled: true, intervalMs: 100 },
        });
        await ticking.ready();
        await expect.poll(() => sub.messages.length, { timeout: 5_000 }).toBeGreaterThan(0);
        const event = wsEventSchema.parse(sub.messages[0]);
        expect(event).toMatchObject({
          type: 'admin.overview.tick',
          activeSnipesLastMinute: 0,
          errorsLastMinute: 0,
        });
      } finally {
        sub.close();
      }
    });
  });
});
