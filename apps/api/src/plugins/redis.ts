// Decorates the Fastify instance with `redis` (general-purpose client, used
// for caching/dedupe/locks/rate-limit store) and `redisSub` (a dedicated
// connection for pub/sub subscriptions — ioredis requires a separate
// connection once you call .subscribe(), since that connection can then only
// be used for pub/sub commands). Both close on shutdown.

import fp from 'fastify-plugin';
import { Redis } from 'ioredis';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    redisSub: Redis;
  }
}

// Test isolation: a dedicated Redis logical DB (SELECT), not a dev/test
// shared DB 0 — this is what NODE_ENV=test connects to below. A first
// attempt at this used ioredis's `keyPrefix` instead, applied uniformly to
// every command; that broke the moment a module handed the *same* prefixed
// client to BullMQ (`new Queue(name, { connection: fastify.redis })` — used
// by the health module's readiness probe, and by admin-system's queue-depth
// inspection), since BullMQ refuses an ioredis connection carrying a
// `keyPrefix` ("use the prefix option instead") — it manages its own key
// namespacing and the two conflict. A separate logical DB sidesteps the
// class of problem entirely: every command (including BullMQ's, and
// SUBSCRIBE/PUBLISH channel names) is naturally isolated with zero
// per-library special-casing, and cleanup is one FLUSHDB. Fixed index
// rather than random since this repo's tests run sequentially
// (fileParallelism: false) — see src/test/global-setup.ts, which FLUSHDBs
// this index once before every test run to also clear any state left by a
// crashed previous run.
const TEST_REDIS_DB = 15;

export default fp(
  async function redisPlugin(fastify: FastifyInstance) {
    const db = fastify.config.NODE_ENV === 'test' ? TEST_REDIS_DB : undefined;

    const redis = new Redis(fastify.config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false, db });
    const redisSub = new Redis(fastify.config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false, db });

    redis.on('error', (err) => fastify.log.error({ err }, 'redis connection error'));
    redisSub.on('error', (err) => fastify.log.error({ err }, 'redis pub/sub connection error'));

    fastify.decorate('redis', redis);
    fastify.decorate('redisSub', redisSub);

    fastify.addHook('onClose', async () => {
      redis.disconnect();
      redisSub.disconnect();
    });
  },
  { name: 'redis' },
);
