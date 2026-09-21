// /api/v1/sessions — list/revoke the caller's own refresh-token sessions.

import { sessions } from '@sl/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { AppErrors } from '../../lib/errors.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const sessionDtoSchema = z.object({
  id: z.string().uuid(),
  deviceId: z.string().uuid().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  isCurrent: z.boolean(),
});

export default fp(
  async function sessionsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/sessions',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['sessions'], response: { 200: z.array(sessionDtoSchema) } },
      },
      async (request) => {
        const rows = await fastify.db.query.sessions.findMany({
          where: and(eq(sessions.userId, request.authUser!.id), isNull(sessions.revokedAt)),
          orderBy: [desc(sessions.lastUsedAt)],
        });
        return rows.map((s) => ({
          id: s.id,
          deviceId: s.deviceId,
          ip: s.ip,
          userAgent: s.userAgent,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          isCurrent: s.id === request.authUser!.sessionId,
        }));
      },
    );

    app.delete(
      '/api/v1/sessions/:id',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['sessions'],
          params: z.object({ id: z.string().uuid() }),
          response: { 200: z.object({ revoked: z.literal(true) }) },
        },
      },
      async (request) => {
        const session = await fastify.db.query.sessions.findFirst({
          where: and(
            eq(sessions.id, request.params.id),
            eq(sessions.userId, request.authUser!.id),
            isNull(sessions.revokedAt),
          ),
        });
        if (!session) throw AppErrors.notFound('session');

        await fastify.db
          .update(sessions)
          .set({ revokedAt: new Date(), revokedReason: 'user' })
          .where(eq(sessions.id, session.id));
        return { revoked: true as const };
      },
    );
  },
  { name: 'module:sessions', dependencies: ['auth', 'db', 'csrf'] },
);
