// POST /api/v1/sniping/attempts — batch ingest of snipe attempt outcomes.

import { devices, snipingActivity } from '@sl/db';
import { reportSnipingAttemptsRequestSchema } from '@sl/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { rollupProfitsForUserDays, utcDay } from '../../lib/analytics/rollup.js';
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

        // `sniping_activity.device_id` is a foreign key. The extension
        // falls back to a placeholder device id when it has not registered
        // yet (see apps/extension/src/content/index.ts's recordAttempt), and
        // a device can be revoked from the dashboard between an attempt and
        // its flush — either used to make the whole batch fail with a 500
        // and get retried forever. Attribute the attempt to the device only
        // when it really is one of this user's; otherwise store it without.
        const claimed = [...new Set(request.body.attempts.map((a) => a.deviceId))];
        const known = new Set(
          (
            await fastify.db.query.devices.findMany({
              columns: { id: true },
              where: and(
                eq(devices.userId, userId),
                inArray(devices.id, claimed),
                isNull(devices.deletedAt),
              ),
            })
          ).map((d) => d.id),
        );

        const rows = request.body.attempts.map((a) => ({
          id: newId(),
          userId,
          deviceId: known.has(a.deviceId) ? a.deviceId : null,
          resourceId: String(a.resourceId),
          tradeId: a.tradeId ?? null,
          targetPrice: a.targetPrice,
          listedPrice: a.listedPrice,
          outcome: a.outcome,
          latencyMs: a.latencyMs,
          errorCode: a.errorCode,
          occurredAt: new Date(a.occurredAt),
        }));
        if (rows.length > 0) {
          await fastify.db.insert(snipingActivity).values(rows);
          // Snipe counts and success rate live in the `profits` rollup too;
          // recompute the days this batch touched so the dashboard's
          // success rate is current on its next request.
          await rollupProfitsForUserDays(
            fastify.db,
            rows.map((r) => ({ userId, day: utcDay(r.occurredAt) })),
          );
        }
        return { accepted: rows.length };
      },
    );
  },
  { name: 'module:sniping', dependencies: ['auth', 'db'] },
);
