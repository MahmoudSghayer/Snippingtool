// POST /api/v1/activity/batch — extension activity ingest (login, logout,
// search, filter_change, settings_change, error, heartbeat). Account-agnostic
// product telemetry only — never raw market data (project instruction 6).
// Idempotent per event: since the shared `activityEventSchema` carries no
// client-assigned event id, idempotency is keyed on a stable hash of the
// event's own content (userId + JSON) — a retried batch with byte-identical
// events is a no-op the second time, which is what "idempotent by client
// event id" protects against in practice (a batch resend after a dropped
// response).

import { createHash } from 'node:crypto';

import { userActivity, searchActivity } from '@sl/db';
import { activityIngestBatchSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { newId } from '../../lib/ids.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

function dedupeKey(userId: string, event: unknown): string {
  const hash = createHash('sha256').update(userId).update(JSON.stringify(event)).digest('hex');
  return `activity:dedupe:${hash}`;
}

export default fp(
  async function activityModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/activity/batch',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['activity'],
          body: activityIngestBatchSchema,
          response: { 200: z.object({ accepted: z.number(), deduped: z.number() }) },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        let accepted = 0;
        let deduped = 0;

        for (const event of request.body.events) {
          const key = dedupeKey(userId, event);
          const isNew = await fastify.redis.set(key, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
          if (!isNew) {
            deduped++;
            continue;
          }
          accepted++;

          const occurredAt = new Date(event.occurredAt);
          const deviceId = event.deviceId ?? request.authUser!.deviceId ?? null;

          if (event.type === 'search') {
            await fastify.db.insert(searchActivity).values({
              id: newId(),
              userId,
              deviceId,
              filterHash: event.metadata.filterHash,
              filter: {},
              resultsCount: event.metadata.resultsCount,
              resourceId: event.metadata.resourceId ? String(event.metadata.resourceId) : null,
              floorPrice: event.metadata.floorPrice ?? null,
              occurredAt,
            });
          } else {
            await fastify.db.insert(userActivity).values({
              id: newId(),
              userId,
              deviceId,
              type: event.type,
              metadata: event.metadata ?? {},
              occurredAt,
            });
          }
        }

        return { accepted, deduped };
      },
    );
  },
  { name: 'module:activity', dependencies: ['auth', 'db', 'redis'] },
);
