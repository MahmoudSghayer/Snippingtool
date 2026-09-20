// /api/v1/admin/toggles — feature flag list/upsert, kill-switch toggle.
// Every change broadcasts a WS event (`feature_toggles.changed`, or
// `kill_switch` specifically for the `kill_switch` key) to `admin:overview`
// AND `user:{id}` for every currently-online user (best-effort: online set
// only, not every user — offline clients pick it up on next heartbeat).


import { featureToggles } from '@sl/db';
import { featureToggleDtoSchema, updateFeatureToggleRequestSchema } from '@sl/shared';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { AppErrors } from '../../lib/errors.js';
import { publishAdmin } from '../../ws/publish.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function toDto(row: typeof featureToggles.$inferSelect) {
  return {
    key: row.key,
    enabled: row.enabled,
    rolloutPercent: row.rolloutPercent,
    planGate: row.planGate.at(0) ?? null,
    updatedBy: row.updatedBy,
  };
}

export default fp(
  async function adminTogglesModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/toggles',
      { onRequest: [fastify.requirePermission('system.read')], schema: { tags: ['admin'], response: { 200: z.array(featureToggleDtoSchema) } } },
      async () => {
        const rows = await fastify.db.query.featureToggles.findMany();
        return rows.map(toDto);
      },
    );

    app.patch(
      '/api/v1/admin/toggles/:key',
      {
        onRequest: [fastify.requirePermission('feature_toggles.write')],
        schema: { tags: ['admin'], params: z.object({ key: z.string().min(1) }), body: updateFeatureToggleRequestSchema, response: { 200: featureToggleDtoSchema } },
      },
      async (request) => {
        const before = await fastify.db.query.featureToggles.findFirst({ where: eq(featureToggles.key, request.params.key) });
        if (!before) throw AppErrors.notFound('feature toggle');

        const [after] = await fastify.db
          .update(featureToggles)
          .set({
            enabled: request.body.enabled ?? before.enabled,
            rolloutPercent: request.body.rolloutPercent ?? before.rolloutPercent,
            planGate: request.body.planGate !== undefined ? (request.body.planGate ? [request.body.planGate] : []) : before.planGate,
            updatedBy: request.authUser!.id,
          })
          .where(eq(featureToggles.id, before.id))
          .returning();

        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'feature_toggle.updated',
          entityType: 'feature_toggle',
          entityId: before.id,
          before: { enabled: before.enabled, rolloutPercent: before.rolloutPercent },
          after: { enabled: after!.enabled, rolloutPercent: after!.rolloutPercent },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        const allToggles = (await fastify.db.query.featureToggles.findMany()).map(toDto);
        await publishAdmin(fastify.redis, { type: 'feature_toggles.changed', toggles: allToggles });

        if (after!.key === 'kill_switch') {
          await publishAdmin(fastify.redis, { type: 'kill_switch', active: after!.enabled, reason: request.body.enabled !== undefined ? 'admin toggle' : undefined });
        }

        return toDto(after!);
      },
    );
  },
  { name: 'module:admin-toggles', dependencies: ['auth', 'db', 'redis'] },
);
