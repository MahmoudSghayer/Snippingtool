// /api/v1/notifications — list (cursor), mark read, and (via
// user_settings.notifications) preferences.


import { notifications } from '@sl/db';
import { paginationQuerySchema, paginatedResponseSchema } from '@sl/shared';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { AppErrors } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const notificationDtoSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  data: z.record(z.unknown()),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export default fp(
  async function notificationsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/notifications',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['notifications'], querystring: paginationQuerySchema, response: { 200: paginatedResponseSchema(notificationDtoSchema) } },
      },
      async (request) => {
        const cursor = decodeCursor(request.query.cursor);
        const limit = request.query.limit;

        const rows = await fastify.db.query.notifications.findMany({
          where: cursor
            ? and(eq(notifications.userId, request.authUser!.id), lt(notifications.createdAt, new Date(cursor.v)))
            : eq(notifications.userId, request.authUser!.id),
          orderBy: [desc(notifications.createdAt)],
          limit: limit + 1,
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1);

        return {
          items: items.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            data: n.data,
            readAt: n.readAt ? n.readAt.toISOString() : null,
            createdAt: n.createdAt.toISOString(),
          })),
          nextCursor: hasMore && last ? encodeCursor({ v: last.createdAt.toISOString(), id: last.id }) : null,
        };
      },
    );

    app.post(
      '/api/v1/notifications/:id/read',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['notifications'], params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ ok: z.literal(true) }) } },
      },
      async (request) => {
        const notification = await fastify.db.query.notifications.findFirst({
          where: and(eq(notifications.id, request.params.id), eq(notifications.userId, request.authUser!.id)),
        });
        if (!notification) throw AppErrors.notFound('notification');
        await fastify.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, notification.id));
        return { ok: true as const };
      },
    );

    app.post(
      '/api/v1/notifications/read-all',
      { onRequest: [fastify.authenticate], schema: { tags: ['notifications'], response: { 200: z.object({ ok: z.literal(true) }) } } },
      async (request) => {
        await fastify.db
          .update(notifications)
          .set({ readAt: new Date() })
          .where(and(eq(notifications.userId, request.authUser!.id), isNull(notifications.readAt)));
        return { ok: true as const };
      },
    );
  },
  { name: 'module:notifications', dependencies: ['auth', 'db'] },
);
