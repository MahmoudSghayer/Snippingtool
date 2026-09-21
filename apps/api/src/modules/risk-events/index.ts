// /api/v1/risk-events — batch ingest of safety-governor decisions (POST), so
// the dashboard can show risk posture and admins can tune defaults, plus
// GET history for the caller's own account and (admin) any one user
// (docs/07-dashboard.md §11 gap #6).

import { riskBudgetEvents } from '@sl/db';
import { paginatedResponseSchema, reportRiskBudgetEventsRequestSchema, riskBudgetEventRowSchema, riskEventQuerySchema } from '@sl/shared';
import { and, desc, eq, gte, lt, lte } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';


import { newId } from '../../lib/ids.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function toRow(r: typeof riskBudgetEvents.$inferSelect) {
  return {
    id: r.id,
    deviceId: r.deviceId,
    sessionId: r.sessionId,
    kind: r.kind,
    value: Number(r.value),
    threshold: Number(r.threshold),
    occurredAt: r.occurredAt.toISOString(),
  };
}

const userIdParams = z.object({ id: z.string().uuid() });

export default fp(
  async function riskEventsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/risk-events',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['risk'], body: reportRiskBudgetEventsRequestSchema, response: { 200: z.object({ accepted: z.number() }) } },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const rows = request.body.events.map((e) => ({
          id: newId(),
          userId,
          deviceId: e.deviceId,
          sessionId: e.sessionId,
          kind: e.kind,
          value: String(e.value),
          threshold: String(e.threshold),
          occurredAt: new Date(e.occurredAt),
        }));
        if (rows.length > 0) await fastify.db.insert(riskBudgetEvents).values(rows);
        return { accepted: rows.length };
      },
    );

    // docs/07-dashboard.md §11 gap #6: the caller's own governor event
    // history, for the Dashboard "Risk posture" card (last-24h counts by
    // kind + recent hard stops) alongside the configured budget (`GET
    // /settings`).
    app.get(
      '/api/v1/risk-events',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['risk'], querystring: riskEventQuerySchema, response: { 200: paginatedResponseSchema(riskBudgetEventRowSchema) } },
      },
      async (request) => {
        const { from, to, kind, cursor: cursorRaw, limit } = request.query;
        const cursor = decodeCursor(cursorRaw);
        const conditions = [eq(riskBudgetEvents.userId, request.authUser!.id)];
        if (kind) conditions.push(eq(riskBudgetEvents.kind, kind));
        if (from) conditions.push(gte(riskBudgetEvents.occurredAt, new Date(from)));
        if (to) conditions.push(lte(riskBudgetEvents.occurredAt, new Date(to)));
        if (cursor) conditions.push(lt(riskBudgetEvents.occurredAt, new Date(cursor.v)));

        const rows = await fastify.db.query.riskBudgetEvents.findMany({
          where: and(...conditions),
          orderBy: [desc(riskBudgetEvents.occurredAt)],
          limit: limit + 1,
        });
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page.at(-1);
        return {
          items: page.map(toRow),
          nextCursor: hasMore && last ? encodeCursor({ v: last.occurredAt.toISOString(), id: last.id }) : null,
        };
      },
    );

    // Admin variant: an admin looking at one user's governor event history —
    // gated on `users.read` (same permission `GET /admin/users/:id` uses),
    // not `analytics.read`, since this is "look at this one account", not a
    // platform-wide report.
    app.get(
      '/api/v1/admin/users/:id/risk-events',
      {
        onRequest: [fastify.requirePermission('users.read')],
        schema: {
          tags: ['admin'],
          summary: "One user's safety-governor event history.",
          params: userIdParams,
          querystring: riskEventQuerySchema,
          response: { 200: paginatedResponseSchema(riskBudgetEventRowSchema) },
        },
      },
      async (request) => {
        const { from, to, kind, cursor: cursorRaw, limit } = request.query;
        const cursor = decodeCursor(cursorRaw);
        const conditions = [eq(riskBudgetEvents.userId, request.params.id)];
        if (kind) conditions.push(eq(riskBudgetEvents.kind, kind));
        if (from) conditions.push(gte(riskBudgetEvents.occurredAt, new Date(from)));
        if (to) conditions.push(lte(riskBudgetEvents.occurredAt, new Date(to)));
        if (cursor) conditions.push(lt(riskBudgetEvents.occurredAt, new Date(cursor.v)));

        const rows = await fastify.db.query.riskBudgetEvents.findMany({
          where: and(...conditions),
          orderBy: [desc(riskBudgetEvents.occurredAt)],
          limit: limit + 1,
        });
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page.at(-1);
        return {
          items: page.map(toRow),
          nextCursor: hasMore && last ? encodeCursor({ v: last.occurredAt.toISOString(), id: last.id }) : null,
        };
      },
    );
  },
  { name: 'module:risk-events', dependencies: ['auth', 'db'] },
);
