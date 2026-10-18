// GET /api/v1/admin/system/health — api uptime, db connectivity, redis info,
// per-queue BullMQ depths, WS presence count, extension version
// distribution, API 5xx count.
//
// Every probe is independent and bounded by `PROBE_TIMEOUT_MS`: one that
// fails or hangs is reported in `degraded` and falls back to an empty
// value, and the rest of the page still renders. The queue probe used to
// open its own `new Redis(REDIS_URL)` without the deployment's TLS CA
// (lib/redis-connection.ts); against production's TLS-only Redis it never
// connected, and with `maxRetriesPerRequest: null` it waited forever, so
// the whole request never answered and /admin/system stayed blank. It now
// uses the app's own, already-connected client.

import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { loadJobs } from '../../jobs/index.js';
import { getVersionDistribution } from '../../lib/analytics/kpi.js';
import { getErrorRate } from '../../lib/error-rate.js';
import { countOnline } from '../../ws/presence.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/** Longest any one probe may take before it is reported as degraded. */
const PROBE_TIMEOUT_MS = 3_000;

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

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type QueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
};

const queueCountsSchema = z.object({
  waiting: z.number(),
  active: z.number(),
  completed: z.number(),
  failed: z.number(),
  delayed: z.number(),
});

const systemHealthResponseSchema = z.object({
  uptimeSeconds: z.number(),
  db: z.object({ connected: z.boolean() }),
  redis: z.object({
    connectedClients: z.string().optional(),
    usedMemory: z.string().optional(),
    uptimeInSeconds: z.string().optional(),
  }),
  queues: z.record(z.string(), queueCountsSchema),
  /** `null` when the presence set could not be read. */
  wsOnlineUsers: z.number().nullable(),
  /** Live installs by version, the same set as the admin Overview's
   * "Extension versions" (lib/analytics/kpi.ts `getVersionDistribution`). */
  extensionVersions: z.record(z.string(), z.number()),
  /** API 5xx responses in the last 5 minutes (a count, from the Redis
   * minute buckets in lib/error-rate.ts); `null` when unreadable. */
  errorRateLast5Min: z.number().nullable(),
  /** Probes that failed or timed out; their fields hold empty values. */
  degraded: z.array(z.string()),
});

export default fp(
  async function adminSystemModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/system/health',
      {
        onRequest: [fastify.requirePermission('system.read')],
        schema: { tags: ['admin'], response: { 200: systemHealthResponseSchema } },
      },
      async (request) => {
        const degraded: string[] = [];
        const probe = async <T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> => {
          try {
            return await withTimeout(run(), PROBE_TIMEOUT_MS, name);
          } catch (err) {
            degraded.push(name);
            request.log.warn({ err, probe: name }, 'system health probe failed');
            return fallback;
          }
        };

        // Each queue is its own probe, so one broken queue never hides the
        // others. `fastify.redis` is the client every other module (and
        // plugins/queues.ts's producers) already uses: TLS settings from
        // lib/redis-connection.ts, and no keyPrefix (BullMQ refuses one).
        const probeQueues = async (): Promise<Record<string, QueueCounts>> => {
          const jobs = await probe('queues', () => loadJobs(), []);
          const entries = await Promise.all(
            jobs.map(async (job) => {
              const counts = await probe<QueueCounts | null>(
                `queue:${job.name}`,
                async () => {
                  const queue = new Queue(job.name, { connection: fastify.redis });
                  try {
                    const c = await queue.getJobCounts(
                      'waiting',
                      'active',
                      'completed',
                      'failed',
                      'delayed',
                    );
                    return {
                      waiting: c.waiting ?? 0,
                      active: c.active ?? 0,
                      completed: c.completed ?? 0,
                      failed: c.failed ?? 0,
                      delayed: c.delayed ?? 0,
                    };
                  } finally {
                    await queue.close();
                  }
                },
                null,
              );
              return [job.name, counts] as const;
            }),
          );
          const queues: Record<string, QueueCounts> = {};
          for (const [name, counts] of entries) if (counts) queues[name] = counts;
          return queues;
        };

        const [dbConnected, info, queues, wsOnlineUsers, extensionVersions, errorRate] =
          await Promise.all([
            probe(
              'db',
              async () => {
                await fastify.db.execute(sql`SELECT 1`);
                return true;
              },
              false,
            ),
            probe('redis', async () => parseRedisInfo(await fastify.redis.info()), {}),
            probeQueues(),
            probe<number | null>('presence', () => countOnline(fastify.redis), null),
            probe('extensionVersions', () => getVersionDistribution(fastify.db), {}),
            probe<number | null>('errorRate', () => getErrorRate(fastify.redis, 5), null),
          ]);

        return {
          uptimeSeconds: process.uptime(),
          db: { connected: dbConnected },
          redis: {
            connectedClients: info.connected_clients,
            usedMemory: info.used_memory_human,
            uptimeInSeconds: info.uptime_in_seconds,
          },
          queues,
          wsOnlineUsers,
          extensionVersions,
          errorRateLast5Min: errorRate,
          degraded,
        };
      },
    );
  },
  { name: 'module:admin-system', dependencies: ['auth', 'db', 'redis'] },
);
