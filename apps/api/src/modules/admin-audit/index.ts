// /api/v1/admin/audit — list/filter audit_logs, and stream a CSV export.

import { auditLogs } from '@sl/db';
import { auditLogEntrySchema, auditLogQuerySchema } from '@sl/shared';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

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

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return `"${str.replace(/"/g, '""')}"`;
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

    app.get(
      '/api/v1/admin/audit/export.csv',
      {
        onRequest: [fastify.requirePermission('audit.read')],
        schema: { tags: ['admin'], querystring: auditLogQuerySchema, hide: true },
      },
      async (request, reply) => {
        const { actorId, entityType, entityId, from, to } = request.query;
        const conditions = [];
        if (actorId) conditions.push(eq(auditLogs.actorId, actorId));
        if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
        if (entityId) conditions.push(eq(auditLogs.entityId, entityId));
        if (from) conditions.push(gte(auditLogs.occurredAt, new Date(from)));
        if (to) conditions.push(lte(auditLogs.occurredAt, new Date(to)));

        const rows = await fastify.db.query.auditLogs.findMany({
          where: conditions.length > 0 ? and(...conditions) : undefined,
          orderBy: [desc(auditLogs.occurredAt)],
          limit: 10_000,
        });

        const header = 'id,occurred_at,actor_type,actor_id,action,entity_type,entity_id,diff\n';
        const body = rows
          .map((r) => [r.id, r.occurredAt.toISOString(), r.actorType, r.actorId, r.action, r.entityType, r.entityId, JSON.stringify(r.diff)].map(csvEscape).join(','))
          .join('\n');

        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="audit-log.csv"');
        return header + body + '\n';
      },
    );
  },
  { name: 'module:admin-audit', dependencies: ['auth', 'db'] },
);
