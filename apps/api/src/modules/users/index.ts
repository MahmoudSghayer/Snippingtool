// /api/v1/users/me — profile get/patch, soft-delete account.

import { users } from '@sl/db';
import { updateProfileRequestSchema, userDtoSchema, type UserDto } from '@sl/shared';
import { and, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { resolveAdminSession, type AdminSessionInfo } from '../../lib/admin-session.js';
import { recordAudit } from '../../lib/audit.js';
import { AppErrors } from '../../lib/errors.js';

import type { User } from '@sl/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function toDto(user: User, admin: AdminSessionInfo): UserDto {
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
    adminRole: admin.adminRole,
    permissions: admin.permissions,
  };
}

export default fp(
  async function usersModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/users/me',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['users'], response: { 200: userDtoSchema } },
      },
      async (request) => {
        const user = await fastify.db.query.users.findFirst({
          where: and(eq(users.id, request.authUser!.id), isNull(users.deletedAt)),
        });
        if (!user) throw AppErrors.notFound('user');
        const admin = await resolveAdminSession(fastify.db, user.id, user.role);
        return toDto(user, admin);
      },
    );

    app.patch(
      '/api/v1/users/me',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['users'],
          body: updateProfileRequestSchema,
          response: { 200: userDtoSchema },
        },
      },
      async (request) => {
        const before = await fastify.db.query.users.findFirst({
          where: eq(users.id, request.authUser!.id),
        });
        if (!before) throw AppErrors.notFound('user');

        const [after] = await fastify.db
          .update(users)
          .set({ timezone: request.body.timezone ?? before.timezone })
          .where(eq(users.id, request.authUser!.id))
          .returning();

        await recordAudit({
          db: fastify.db,
          actor: { type: 'user', id: request.authUser!.id },
          action: 'user.profile_updated',
          entityType: 'user',
          entityId: request.authUser!.id,
          before: { timezone: before.timezone },
          after: { timezone: after!.timezone },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        const admin = await resolveAdminSession(fastify.db, after!.id, after!.role);
        return toDto(after!, admin);
      },
    );

    app.delete(
      '/api/v1/users/me',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['users'],
          body: z.object({ password: z.string().min(1) }),
          response: { 200: z.object({ deleted: z.literal(true) }) },
        },
      },
      async (request) => {
        const user = await fastify.db.query.users.findFirst({
          where: eq(users.id, request.authUser!.id),
        });
        if (!user) throw AppErrors.notFound('user');

        const { verifySecret } = await import('../../lib/crypto.js');
        if (!(await verifySecret(user.passwordHash, request.body.password)))
          throw AppErrors.invalidCredentials();

        await fastify.db
          .update(users)
          .set({ status: 'deleted', deletedAt: new Date() })
          .where(eq(users.id, user.id));

        const { revokeAllUserSessions, bumpUserVersion } = await import('../auth/repo.js');
        await revokeAllUserSessions(fastify.db, user.id, 'account_deleted');
        await bumpUserVersion(fastify.db, user.id);

        await recordAudit({
          db: fastify.db,
          actor: { type: 'user', id: user.id },
          action: 'user.deleted',
          entityType: 'user',
          entityId: user.id,
          before: { status: user.status },
          after: { status: 'deleted' },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return { deleted: true as const };
      },
    );
  },
  { name: 'module:users', dependencies: ['auth', 'db', 'csrf'] },
);
