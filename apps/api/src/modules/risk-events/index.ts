// POST /api/v1/risk-events — batch ingest of safety-governor decisions, so
// the dashboard can show risk posture and admins can tune defaults.

import { riskBudgetEvents } from '@sl/db';
import { reportRiskBudgetEventsRequestSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { z } from 'zod';


import { newId } from '../../lib/ids.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export default fp(
  async function riskEventsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/risk-events',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['risk'], body: reportRiskBudgetEventsRequestSchema, response: { 200: z.object({ accepted: z.number() }) } },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const rows = request.body.events.map((e) => ({
          id: newId(),
          userId,
          deviceId: e.deviceId,
          sessionId: e.sessionId,
          kind: e.kind,
          value: String(e.value),
          threshold: String(e.threshold),
          occurredAt: new Date(e.occurredAt),
        }));
        if (rows.length > 0) await fastify.db.insert(riskBudgetEvents).values(rows);
        return { accepted: rows.length };
      },
    );
  },
  { name: 'module:risk-events', dependencies: ['auth', 'db'] },
);
