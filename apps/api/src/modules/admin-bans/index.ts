// Admin ban management: create (account/ip/device/hwid), lift, list. An
// account ban immediately revokes every active session
// (docs/05-subscriptions.md §8) via `modules/bans/service.ts`.

import { banDtoSchema, createBanRequestSchema, liftBanRequestSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import {
  recordAdminAction,
  requireAdminUsersRowId,
  toAuditSnapshot,
} from '../admin-subscriptions/admin-action-log.js';
import { createBan, liftBan, listBans, type BanRow } from '../bans/service.js';

import type { FastifyInstance } from 'fastify';

export const autoPrefix = '/api/v1/admin/bans';

function toBanDto(row: BanRow) {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    value: row.value,
    reason: row.reason,
    issuedBy: row.issuedBy,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    liftedAt: row.liftedAt ? row.liftedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export default fp(
  async function adminBansModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/bans',
      {
        onRequest: [fastify.requirePermission('users.ban')],
        schema: {
          tags: ['admin-bans'],
          summary: 'List bans.',
          querystring: z.object({ active: z.coerce.boolean().optional() }),
          response: { 200: z.object({ items: z.array(banDtoSchema) }) },
        },
      },
      async (request) => {
        const rows = await listBans(fastify.db, { active: request.query.active });
        return { items: rows.map(toBanDto) };
      },
    );

    app.post(
      '/api/v1/admin/bans',
      {
        onRequest: [fastify.requirePermission('users.ban')],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['admin-bans'],
          summary: 'Create a ban (account/ip/device/hwid), with an optional expiry.',
          body: createBanRequestSchema,
          response: { 201: banDtoSchema },
        },
      },
      async (request, reply) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const row = await createBan(fastify.db, fastify.redis, {
          type: request.body.type,
          value: request.body.value ?? '',
          userId: request.body.userId ?? null,
          reason: request.body.reason,
          issuedBy: request.authUser!.id,
          expiresAt: request.body.expiresAt ? new Date(request.body.expiresAt) : null,
        });

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'ban.create',
          targetType: 'ban',
          targetId: row.id,
          reason: request.body.reason,
          metadata: { type: row.type, value: row.value, userId: row.userId },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'ban.create',
          entityType: 'ban',
          entityId: row.id,
          before: null,
          after: toAuditSnapshot(row),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return reply.status(201).send(toBanDto(row));
      },
    );

    app.post(
      '/api/v1/admin/bans/:id/lift',
      {
        onRequest: [fastify.requirePermission('users.ban')],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['admin-bans'],
          summary: 'Lift a ban.',
          params: z.object({ id: z.string().uuid() }),
          body: liftBanRequestSchema,
          response: { 200: banDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const before = await fastify.db.query.bans.findFirst({
          where: (t, { eq: eqOp }) => eqOp(t.id, request.params.id),
        });
        const after = await liftBan(fastify.db, fastify.redis, request.params.id);

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'ban.lift',
          targetType: 'ban',
          targetId: after.id,
          reason: request.body.reason,
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'ban.lift',
          entityType: 'ban',
          entityId: after.id,
          before: before ? toAuditSnapshot(before) : null,
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toBanDto(after);
      },
    );
  },
  { name: 'module:admin-bans', dependencies: ['auth', 'db', 'redis'] },
);
