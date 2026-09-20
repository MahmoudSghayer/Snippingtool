// Admin abuse/fraud flag review queue: list (filterable), review, dismiss.
// Flags are created by `modules/subscriptions` (trial abuse) and the
// `abuse.scan` job; this module only reads and triages them.

import { adminFlagListQuerySchema, flagDtoSchema, reviewFlagRequestSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { recordAdminAction, requireAdminUsersRowId, toAuditSnapshot } from '../admin-subscriptions/admin-action-log.js';
import { listFlags, reviewFlag, type FlagRow } from '../flags/service.js';

import type { FastifyInstance } from 'fastify';

export const autoPrefix = '/api/v1/admin/flags';

function toFlagDto(row: FlagRow) {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    severity: row.severity,
    evidence: row.evidence,
    status: row.status,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export default fp(
  async function adminFlagsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/flags',
      {
        onRequest: [fastify.requirePermission('users.read')],
        schema: {
          tags: ['admin-flags'],
          summary: 'List abuse/fraud flags, optionally filtered.',
          querystring: adminFlagListQuerySchema,
          response: { 200: z.object({ items: z.array(flagDtoSchema) }) },
        },
      },
      async (request) => {
        const rows = await listFlags(fastify.db, request.query);
        return { items: rows.map(toFlagDto) };
      },
    );

    app.post(
      '/api/v1/admin/flags/:id/review',
      {
        onRequest: [fastify.requirePermission('users.suspend')],
        schema: {
          tags: ['admin-flags'],
          summary: 'Mark a flag reviewed or dismissed.',
          params: z.object({ id: z.string().uuid() }),
          body: reviewFlagRequestSchema,
          response: { 200: flagDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { before, after } = await reviewFlag(fastify.db, request.params.id, {
          status: request.body.status,
          reviewedBy: request.authUser!.id,
        });

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: `flag.${request.body.status}`,
          targetType: 'flag',
          targetId: after.id,
          reason: request.body.reason,
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: `flag.${request.body.status}`,
          entityType: 'flag',
          entityId: after.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toFlagDto(after);
      },
    );
  },
  { name: 'module:admin-flags', dependencies: ['auth', 'db'] },
);
