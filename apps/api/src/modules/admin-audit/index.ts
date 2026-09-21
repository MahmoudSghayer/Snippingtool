// /api/v1/admin/audit — list/filter audit_logs, and stream a CSV export.

import { auditLogs } from '@sl/db';
import { auditLogEntrySchema, auditLogQuerySchema } from '@sl/shared';
import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { csvStream } from '../../lib/analytics/csv.js';
import { recordAudit } from '../../lib/audit.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function toDto(row: typeof auditLogs.$inferSelect) {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before,
    after: row.after,
    diff: row.diff,
    requestId: row.requestId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

export default fp(
  async function adminAuditModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/audit',
      {
        onRequest: [fastify.requirePermission('audit.read')],
        schema: {
          tags: ['admin'],
          querystring: auditLogQuerySchema.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
          response: { 200: z.array(auditLogEntrySchema) },
        },
      },
      async (request) => {
        const { actorId, entityType, entityId, from, to, limit } = request.query;
        const conditions = [];
        if (actorId) conditions.push(eq(auditLogs.actorId, actorId));
        if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
        if (entityId) conditions.push(eq(auditLogs.entityId, entityId));
        if (from) conditions.push(gte(auditLogs.occurredAt, new Date(from)));
        if (to) conditions.push(lte(auditLogs.occurredAt, new Date(to)));

        const rows = await fastify.db.query.auditLogs.findMany({
          where: conditions.length > 0 ? and(...conditions) : undefined,
          orderBy: [desc(auditLogs.occurredAt)],
          limit,
        });
        return rows.map(toDto);
      },
    );

    // docs/07-dashboard.md §11 gap #3 / docs/09-security.md: a server-side
    // export with the *same* filters as the list above (auditLogQuerySchema,
    // no separate/narrower filter set), streamed via `csvStream` (matches
    // admin-analytics' reports/* pattern) instead of buffering a 10k-row cap
    // in memory, and recording an `audit.export` audit row before streaming
    // starts — same shape as admin-analytics' `analytics.export`.
    app.get(
      '/api/v1/admin/audit/export.csv',
      {
        onRequest: [fastify.requirePermission('audit.read')],
        schema: { tags: ['admin'], summary: 'Stream every audit_logs row matching the given filters as CSV.', querystring: auditLogQuerySchema },
      },
      async (request, reply) => {
        const { actorId, entityType, entityId, from, to } = request.query;
        const conditions: SQL[] = [];
        if (actorId) conditions.push(eq(auditLogs.actorId, actorId));
        if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
        if (entityId) conditions.push(eq(auditLogs.entityId, entityId));
        if (from) conditions.push(gte(auditLogs.occurredAt, new Date(from)));
        if (to) conditions.push(lte(auditLogs.occurredAt, new Date(to)));

        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'audit.export',
          entityType: 'audit_log',
          entityId: null,
          before: null,
          after: { actorId: actorId ?? null, entityType: entityType ?? null, entityId: entityId ?? null, from: from ?? null, to: to ?? null },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        // Keyset-paginated generator (occurred_at DESC, id tiebreaker) so
        // `csvStream` never has to hold more than one page of rows in memory
        // at a time, however large the export — each page is fetched lazily
        // as the previous one is consumed by the HTTP response stream.
        const PAGE_SIZE = 1000;
        async function* pages() {
          let cursor: { occurredAt: Date; id: string } | null = null;
          for (;;) {
            const pageConditions: SQL[] = cursor ? [...conditions, lt(auditLogs.occurredAt, cursor.occurredAt)] : conditions;
            const rows = await fastify.db.query.auditLogs.findMany({
              where: pageConditions.length > 0 ? and(...pageConditions) : undefined,
              orderBy: [desc(auditLogs.occurredAt)],
              limit: PAGE_SIZE,
            });
            if (rows.length === 0) return;
            for (const r of rows) {
              yield {
                id: r.id,
                occurredAt: r.occurredAt.toISOString(),
                actorType: r.actorType,
                actorId: r.actorId ?? '',
                action: r.action,
                entityType: r.entityType,
                entityId: r.entityId ?? '',
                diff: r.diff,
              };
            }
            if (rows.length < PAGE_SIZE) return;
            const last = rows.at(-1)!;
            cursor = { occurredAt: last.occurredAt, id: last.id };
          }
        }

        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="audit-log.csv"');
        return reply.send(
          csvStream(
            [
              { key: 'id', header: 'id' },
              { key: 'occurredAt', header: 'occurred_at' },
              { key: 'actorType', header: 'actor_type' },
              { key: 'actorId', header: 'actor_id' },
              { key: 'action', header: 'action' },
              { key: 'entityType', header: 'entity_type' },
              { key: 'entityId', header: 'entity_id' },
              { key: 'diff', header: 'diff' },
            ],
            pages(),
          ),
        );
      },
    );
  },
  { name: 'module:admin-audit', dependencies: ['auth', 'db'] },
);
