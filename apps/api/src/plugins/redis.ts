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
// per-library special-casing, and cleanup is one FLUSHDB. The index is
// `REDIS_TEST_DB` (config/env.ts, default 15, matching the previous fixed
// value) rather than hard-coded, so two test runs that must not collide
// (this repo's own `pnpm test` vs. a parallel suite pointed at a different
// TEST_DATABASE_URL) can use different Redis DBs too. Fixed rather than
// random since this repo's own tests run sequentially within one run
// (fileParallelism: false) — see src/test/global-setup.ts, which FLUSHDBs
// the configured index once before every test run to also clear any state
// left by a crashed previous run.
export default fp(
  async function redisPlugin(fastify: FastifyInstance) {
    const isTest = fastify.config.NODE_ENV === 'test';
    const db = isTest ? fastify.config.REDIS_TEST_DB : undefined;

    const redis = new Redis(fastify.config.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
      db,
    });
    const redisSub = new Redis(fastify.config.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
      db,
    });

    redis.on('error', (err) => fastify.log.error({ err }, 'redis connection error'));
    redisSub.on('error', (err) => fastify.log.error({ err }, 'redis pub/sub connection error'));

    if (isTest) {
      // Every `buildApp()` call is one test FILE's `beforeAll` (each file
      // builds its own app once, per this codebase's own test convention —
      // see any `modules/*/__tests__/*.test.ts`). Flushing here, once per
      // app instance, isolates Redis state *between test files* the same
      // way `resetDatabase()` in each file's own `beforeEach` already
      // isolates Postgres state between individual tests — global-setup's
      // FLUSHDB only runs once for the whole `pnpm test` run, which left
      // rate-limit counters, MFA tickets, dedupe keys, etc. from one file
      // visible to the next (found via real cross-file flakiness: two
      // otherwise-passing files started intermittently failing each other's
      // login/trial-abuse assertions only when run together, never alone).
      await redis.flushdb();
    }

    fastify.decorate('redis', redis);
    fastify.decorate('redisSub', redisSub);

    fastify.addHook('onClose', async () => {
      redis.disconnect();
      redisSub.disconnect();
    });
  },
  { name: 'redis' },
);
