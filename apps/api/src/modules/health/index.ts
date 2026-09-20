// Liveness/readiness probes, unprefixed (`/health/live`, `/health/ready`)
// per the PHASE 3 spec, since they're hit by infra (load balancer /
// orchestrator health checks), not API clients. Full paths, not a prefix
// option — see the module convention note in apps/api/SKELETON_READY:
// `fastify-plugin`-wrapped plugins are deliberately non-encapsulated, and
// Fastify's `prefix` option only applies to encapsulated children, so every
// module writes its own absolute path for every route.

import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

export default fp(
  async function healthModule(fastify: FastifyInstance) {
    // One lightweight Queue handle reused for readiness checks — BullMQ
    // accepts an existing ioredis connection, so this adds no new sockets.
    const probeQueue = new Queue('health.probe', { connection: fastify.redis });
    fastify.addHook('onClose', async () => {
      await probeQueue.close();
    });

    fastify.get(
      '/health/live',
      { schema: { tags: ['health'], response: { 200: z.object({ status: z.literal('ok') }) } } },
      async () => ({ status: 'ok' as const }),
    );

    fastify.get(
      '/health/ready',
      {
        schema: {
          tags: ['health'],
          response: {
            200: z.object({
              status: z.literal('ok'),
              checks: z.object({ db: z.literal('ok'), redis: z.literal('ok'), queue: z.literal('ok') }),
            }),
            503: z.object({
              status: z.literal('error'),
              checks: z.record(z.enum(['ok', 'error'])),
            }),
          },
        },
      },
      async (_request, reply) => {
        const checks: Record<string, 'ok' | 'error'> = { db: 'error', redis: 'error', queue: 'error' };

        try {
          await fastify.db.execute(sql`SELECT 1`);
          checks.db = 'ok';
        } catch (err) {
          fastify.log.warn({ err }, 'readiness: db check failed');
        }

        try {
          const pong = await fastify.redis.ping();
          checks.redis = pong === 'PONG' ? 'ok' : 'error';
        } catch (err) {
          fastify.log.warn({ err }, 'readiness: redis check failed');
        }

        try {
          await probeQueue.getJobCounts();
          checks.queue = 'ok';
        } catch (err) {
          fastify.log.warn({ err }, 'readiness: queue check failed');
        }

        const allOk = Object.values(checks).every((v) => v === 'ok');
        if (!allOk) {
          return reply.status(503).send({ status: 'error', checks });
        }
        return { status: 'ok' as const, checks: checks as { db: 'ok'; redis: 'ok'; queue: 'ok' } };
      },
    );
  },
  { name: 'module:health', dependencies: ['db', 'redis'] },
);
