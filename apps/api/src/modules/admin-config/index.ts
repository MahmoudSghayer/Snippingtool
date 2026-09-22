// /api/v1/admin/config — system_config list/upsert, with `is_secret` value
// masking for anyone without config.write (read-only viewers still see that
// a secret key exists, just not its value).

import { systemConfig } from '@sl/db';
import { systemConfigDtoSchema } from '@sl/shared';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function toDto(row: typeof systemConfig.$inferSelect, canReveal: boolean) {
  return {
    key: row.key,
    value: row.isSecret && !canReveal ? '[hidden]' : row.value,
    isSecret: row.isSecret,
    updatedBy: row.updatedBy,
  };
}

export default fp(
  async function adminConfigModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/config',
      {
        onRequest: [fastify.requirePermission('system.read')],
        schema: { tags: ['admin'], response: { 200: z.array(systemConfigDtoSchema) } },
      },
      async (request) => {
        const canReveal = await hasConfigWrite(fastify, request.authUser!.id);
        const rows = await fastify.db.query.systemConfig.findMany();
        return rows.map((r) => toDto(r, canReveal));
      },
    );

    app.put(
      '/api/v1/admin/config/:key',
      {
        onRequest: [fastify.requirePermission('config.write')],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['admin'],
          params: z.object({ key: z.string().min(1) }),
          body: z.object({
            value: z.unknown(),
            isSecret: z.boolean().optional(),
            description: z.string().max(500).optional(),
          }),
          response: { 200: systemConfigDtoSchema },
        },
      },
      async (request) => {
        const existing = await fastify.db.query.systemConfig.findFirst({
          where: eq(systemConfig.key, request.params.key),
        });

        let after: typeof systemConfig.$inferSelect;
        if (existing) {
          const [row] = await fastify.db
            .update(systemConfig)
            .set({
              value: request.body.value,
              isSecret: request.body.isSecret ?? existing.isSecret,
              description: request.body.description ?? existing.description,
              updatedBy: request.authUser!.id,
            })
            .where(eq(systemConfig.id, existing.id))
            .returning();
          after = row!;
        } else {
          const [row] = await fastify.db
            .insert(systemConfig)
            .values({
              id: newId(),
              key: request.params.key,
              value: request.body.value,
              isSecret: request.body.isSecret ?? false,
              description: request.body.description ?? null,
              updatedBy: request.authUser!.id,
            })
            .returning();
          after = row!;
        }

        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: existing ? 'system_config.updated' : 'system_config.created',
          entityType: 'system_config',
          entityId: after.id,
          before: existing ? { value: existing.isSecret ? '[hidden]' : existing.value } : null,
          after: { value: after.isSecret ? '[hidden]' : after.value },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toDto(after, true);
      },
    );
  },
  { name: 'module:admin-config', dependencies: ['auth', 'db'] },
);

async function hasConfigWrite(fastify: FastifyInstance, userId: string): Promise<boolean> {
  const { adminUsers } = await import('@sl/db');
  const { hasPermission, isAdminRole } = await import('@sl/shared');
  const row = await fastify.db.query.adminUsers.findFirst({ where: eq(adminUsers.userId, userId) });
  if (!row || !isAdminRole(row.adminRole)) return false;
  return hasPermission(row.adminRole, 'config.write');
}
