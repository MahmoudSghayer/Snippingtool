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

export default fp(
  async function redisPlugin(fastify: FastifyInstance) {
    const redis = new Redis(fastify.config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    const redisSub = new Redis(fastify.config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });

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
