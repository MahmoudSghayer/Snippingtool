// GET /api/v1/admin/system/health — api uptime, db connectivity, redis info,
// per-queue BullMQ depths, WS presence count, extension version
// distribution, error rate.

import { sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

import { getErrorRate } from '../../lib/error-rate.js';
import { countOnline } from '../../ws/presence.js';

import type { FastifyInstance } from 'fastify';

function parseRedisInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of info.split('\r\n')) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

export default fp(
  async function adminSystemModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/system/health',
      {
        onRequest: [fastify.requirePermission('system.read')],
        schema: {
          tags: ['admin'],
          response: {
            200: z.object({
              uptimeSeconds: z.number(),
              db: z.object({ connected: z.boolean() }),
              redis: z.object({ connectedClients: z.string().optional(), usedMemory: z.string().optional(), uptimeInSeconds: z.string().optional() }),
              queues: z.record(z.object({ waiting: z.number(), active: z.number(), completed: z.number(), failed: z.number(), delayed: z.number() })),
              wsOnlineUsers: z.number(),
              extensionVersions: z.record(z.number()),
              errorRateLast5Min: z.number(),
            }),
          },
        },
      },
      async () => {
        let dbConnected = true;
        try {
          await fastify.db.execute(sql`SELECT 1`);
        } catch {
          dbConnected = false;
        }

        const infoRaw = await fastify.redis.info().catch(() => '');
        const info = parseRedisInfo(infoRaw);

        // A plain, unprefixed connection matching what worker.ts itself
        // connects with (not `fastify.redis`, which under NODE_ENV=test
        // points at the isolated test DB — see plugins/redis.ts — and, more
        // importantly, cannot be handed to BullMQ at all once it carried a
        // `keyPrefix`, which it no longer does, but a dedicated connection
        // here still keeps this probe's depths meaning "what the real
        // worker process sees" regardless of which DB *this* process is on).
        const { loadJobs } = await import('../../jobs/index.js');
        const jobs = await loadJobs().catch(() => []);
        const queues: Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number }> = {};
        const probeConnection = new Redis(fastify.config.REDIS_URL, { maxRetriesPerRequest: null });
        try {
          for (const job of jobs) {
            const queue = new Queue(job.name, { connection: probeConnection });
            try {
              const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
              queues[job.name] = {
                waiting: counts.waiting ?? 0,
                active: counts.active ?? 0,
                completed: counts.completed ?? 0,
                failed: counts.failed ?? 0,
                delayed: counts.delayed ?? 0,
              };
            } finally {
              await queue.close();
            }
          }
        } finally {
          probeConnection.disconnect();
        }

        const deviceRows = await fastify.db.query.devices.findMany({ where: (d, { eq }) => eq(d.status, 'active') });
        const extensionVersions: Record<string, number> = {};
        for (const d of deviceRows) {
          const v = d.extensionVersion ?? 'unknown';
          extensionVersions[v] = (extensionVersions[v] ?? 0) + 1;
        }

        return {
          uptimeSeconds: process.uptime(),
          db: { connected: dbConnected },
          redis: { connectedClients: info.connected_clients, usedMemory: info.used_memory_human, uptimeInSeconds: info.uptime_in_seconds },
          queues,
          wsOnlineUsers: await countOnline(fastify.redis),
          extensionVersions,
          errorRateLast5Min: await getErrorRate(fastify.redis, 5),
        };
      },
    );
  },
  { name: 'module:admin-system', dependencies: ['auth', 'db', 'redis'] },
);
