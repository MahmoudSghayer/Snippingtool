// /api/v1/admin/users — search/get/patch/suspend/unsuspend/reset-password/
// force-logout. Every mutation is permission-gated per @sl/shared's
// PERMISSION_MATRIX and writes an audit_logs row (before/after) via
// recordAudit, plus an admin_actions row for the admin-specific action log.

import { and, desc, eq, ilike, lt } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  adminSuspendUserRequestSchema,
  paginatedResponseSchema,
  updateProfileRequestSchema,
  userDtoSchema,
  type UserDto,
} from '@sl/shared';
import { z } from 'zod';

import { adminActions, users, type User } from '@sl/db';

import { recordAudit } from '../../lib/audit.js';
import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { forceLogoutNoticeHtml, forceLogoutNoticeText } from '../../emails/templates.js';
import { publishToUser } from '../../ws/publish.js';
import { revokeAllUserSessions, bumpUserVersion } from '../auth/repo.js';

import type { FastifyInstance } from 'fastify';

function toDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
    status: user.status,
    role: user.role,
    totpEnabled: Boolean(user.totpEnabledAt),
    timezone: user.timezone,
    referralCode: user.referralCode,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

/** Records both the polymorphic `audit_logs` row (via recordAudit) and an
 * `admin_actions` row — the latter is the admin-specific, non-polymorphic
 * log `docs/02-database.md` describes for admin_users' own action history. */
async function logAdminAction(
  fastify: FastifyInstance,
  adminUserRowId: string,
  actorUserId: string,
  action: string,
  targetId: string,
  reason: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  request: { ip: string; headers: Record<string, unknown>; id: string },
) {
  await fastify.db.insert(adminActions).values({
    id: newId(),
    adminUserId: adminUserRowId,
    action,
    targetType: 'user',
    targetId,
    reason,
    metadata: {},
  });
  await recordAudit({
    db: fastify.db,
    actor: { type: 'admin', id: actorUserId },
    action,
    entityType: 'user',
    entityId: targetId,
    before,
    after,
    ip: request.ip,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    requestId: request.id,
  });
}

async function getAdminUserRowId(fastify: FastifyInstance, userId: string): Promise<string> {
  const { adminUsers } = await import('@sl/db');
  const row = await fastify.db.query.adminUsers.findFirst({ where: eq(adminUsers.userId, userId) });
  if (!row) throw AppErrors.forbidden('Admin profile not found.');
  return row.id;
}

export default fp(
  async function adminUsersModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/users',
      {
        onRequest: [fastify.requirePermission('users.read')],
        schema: {
          tags: ['admin'],
          querystring: z.object({
            q: z.string().min(1).max(320).optional(),
            status: z.enum(['active', 'suspended', 'banned', 'deleted']).optional(),
            cursor: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: { 200: paginatedResponseSchema(userDtoSchema) },
        },
      },
      async (request) => {
        const { q, status, cursor: cursorRaw, limit } = request.query;
        const cursor = decodeCursor(cursorRaw);

        const conditions = [];
        if (q) conditions.push(ilike(users.email, `%${q}%`));
        if (status) conditions.push(eq(users.status, status));
        if (cursor) conditions.push(lt(users.createdAt, new Date(cursor.v)));

        const rows = await fastify.db.query.users.findMany({
          where: conditions.length > 0 ? and(...conditions) : undefined,
          orderBy: [desc(users.createdAt)],
          limit: limit + 1,
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1);

        return {
          items: items.map(toDto),
          nextCursor: hasMore && last ? encodeCursor({ v: last.createdAt.toISOString(), id: last.id }) : null,
        };
      },
    );

    app.get(
      '/api/v1/admin/users/:id',
      { onRequest: [fastify.requirePermission('users.read')], schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }), response: { 200: userDtoSchema } } },
      async (request) => {
        const user = await fastify.db.query.users.findFirst({ where: eq(users.id, request.params.id) });
        if (!user) throw AppErrors.notFound('user');
        return toDto(user);
      },
    );

    app.patch(
      '/api/v1/admin/users/:id',
      {
        onRequest: [fastify.requirePermission('users.write')],
        schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }), body: updateProfileRequestSchema, response: { 200: userDtoSchema } },
      },
      async (request) => {
        const before = await fastify.db.query.users.findFirst({ where: eq(users.id, request.params.id) });
        if (!before) throw AppErrors.notFound('user');

        const [after] = await fastify.db
          .update(users)
          .set({ timezone: request.body.timezone ?? before.timezone })
          .where(eq(users.id, before.id))
          .returning();

        const adminRowId = await getAdminUserRowId(fastify, request.authUser!.id);
        await logAdminAction(fastify, adminRowId, request.authUser!.id, 'user.updated', before.id, 'admin profile edit', { timezone: before.timezone }, { timezone: after!.timezone }, request);

        return toDto(after!);
      },
    );

    app.post(
      '/api/v1/admin/users/:id/suspend',
      {
        onRequest: [fastify.requirePermission('users.suspend')],
        schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }), body: adminSuspendUserRequestSchema, response: { 200: userDtoSchema } },
      },
      async (request) => {
        const before = await fastify.db.query.users.findFirst({ where: eq(users.id, request.params.id) });
        if (!before) throw AppErrors.notFound('user');

        const [after] = await fastify.db.update(users).set({ status: 'suspended' }).where(eq(users.id, before.id)).returning();
        await revokeAllUserSessions(fastify.db, before.id, 'admin_suspend');
        await bumpUserVersion(fastify.db, before.id);

        const adminRowId = await getAdminUserRowId(fastify, request.authUser!.id);
        await logAdminAction(fastify, adminRowId, request.authUser!.id, 'user.suspended', before.id, request.body.reason, { status: before.status }, { status: 'suspended' }, request);

        return toDto(after!);
      },
    );

    app.post(
      '/api/v1/admin/users/:id/unsuspend',
      {
        onRequest: [fastify.requirePermission('users.suspend')],
        schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().min(1).max(1000) }), response: { 200: userDtoSchema } },
      },
      async (request) => {
        const before = await fastify.db.query.users.findFirst({ where: eq(users.id, request.params.id) });
        if (!before) throw AppErrors.notFound('user');

        const [after] = await fastify.db.update(users).set({ status: 'active' }).where(eq(users.id, before.id)).returning();

        const adminRowId = await getAdminUserRowId(fastify, request.authUser!.id);
        await logAdminAction(fastify, adminRowId, request.authUser!.id, 'user.unsuspended', before.id, request.body.reason, { status: before.status }, { status: 'active' }, request);

        return toDto(after!);
      },
    );

    app.post(
      '/api/v1/admin/users/:id/reset-password',
      {
        onRequest: [fastify.requirePermission('users.reset_password')],
        schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().min(1).max(1000) }), response: { 200: z.object({ sent: z.literal(true) }) } },
      },
      async (request) => {
        const user = await fastify.db.query.users.findFirst({ where: eq(users.id, request.params.id) });
        if (!user) throw AppErrors.notFound('user');

        const { requestPasswordReset } = await import('../auth/service.js');
        await requestPasswordReset(
          {
            db: fastify.db,
            redis: fastify.redis,
            entitlements: fastify.entitlements,
            mailer: fastify.mailer,
            jwtPrivateKey: fastify.config.JWT_PRIVATE_KEY ?? '',
            cookieSecret: fastify.config.COOKIE_SECRET,
          },
          user.email,
          request.ip,
        );

        const adminRowId = await getAdminUserRowId(fastify, request.authUser!.id);
        await logAdminAction(fastify, adminRowId, request.authUser!.id, 'user.reset_password_sent', user.id, request.body.reason, null, null, request);

        return { sent: true as const };
      },
    );

    app.post(
      '/api/v1/admin/users/:id/force-logout',
      {
        onRequest: [fastify.requirePermission('users.force_logout')],
        schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().min(1).max(1000) }), response: { 200: z.object({ ok: z.literal(true) }) } },
      },
      async (request) => {
        const user = await fastify.db.query.users.findFirst({ where: eq(users.id, request.params.id) });
        if (!user) throw AppErrors.notFound('user');

        const revokedSessionIds = await revokeAllUserSessions(fastify.db, user.id, 'admin_force_logout');
        await bumpUserVersion(fastify.db, user.id);

        for (const sessionId of revokedSessionIds) {
          await publishToUser(fastify.redis, user.id, { type: 'session.revoked', sessionId, reason: 'admin_force_logout' });
        }

        await fastify.mailer
          .send({
            to: user.email,
            subject: "You've been signed out — The Sniper's Ledger",
            html: forceLogoutNoticeHtml(request.body.reason),
            text: forceLogoutNoticeText(request.body.reason),
          })
          .catch((err) => fastify.log.warn({ err }, 'force-logout notice email failed'));

        const adminRowId = await getAdminUserRowId(fastify, request.authUser!.id);
        await logAdminAction(fastify, adminRowId, request.authUser!.id, 'user.force_logout', user.id, request.body.reason, null, { sessionsRevoked: revokedSessionIds.length }, request);

        return { ok: true as const };
      },
    );
  },
  { name: 'module:admin-users', dependencies: ['auth', 'db', 'redis', 'mailer'] },
);
