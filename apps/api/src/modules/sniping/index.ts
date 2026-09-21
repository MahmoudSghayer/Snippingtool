// POST /api/v1/sniping/attempts — batch ingest of snipe attempt outcomes.

import { snipingActivity } from '@sl/db';
import { reportSnipingAttemptsRequestSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { newId } from '../../lib/ids.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export default fp(
  async function snipingModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/sniping/attempts',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['sniping'],
          body: reportSnipingAttemptsRequestSchema,
          response: { 200: z.object({ accepted: z.number() }) },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const rows = request.body.attempts.map((a) => ({
          id: newId(),
          userId,
          deviceId: a.deviceId,
          resourceId: String(a.resourceId),
          tradeId: a.tradeId ?? null,
          targetPrice: a.targetPrice,
          listedPrice: a.listedPrice,
          outcome: a.outcome,
          latencyMs: a.latencyMs,
          errorCode: a.errorCode,
          occurredAt: new Date(a.occurredAt),
        }));
        if (rows.length > 0) await fastify.db.insert(snipingActivity).values(rows);
        return { accepted: rows.length };
      },
    );
  },
  { name: 'module:sniping', dependencies: ['auth', 'db'] },
);
