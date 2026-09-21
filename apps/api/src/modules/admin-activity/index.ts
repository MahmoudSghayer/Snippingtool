// /api/v1/admin/activity/* — activity monitoring: logins, searches, snipes,
// errors, devices, IPs. Date range + cursor on every list.

import { devices, ipActivity, searchActivity, snipingActivity, userActivity } from '@sl/db';
import {
  adminActivityDevicesSummarySchema,
  adminErrorActivityRowSchema,
  adminIpActivityRowSchema,
  adminLoginActivityRowSchema,
  adminSearchActivityRowSchema,
  adminSnipeActivityRowSchema,
  paginatedResponseSchema,
} from '@sl/shared';
import { and, desc, eq, gte, lte, lt } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';


import { decodeCursor, encodeCursor } from '../../lib/pagination.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

const rangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export default fp(
  async function adminActivityModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const gate = fastify.requirePermission('analytics.read');

    app.get(
      '/api/v1/admin/activity/logins',
      { onRequest: [gate], schema: { tags: ['admin'], querystring: rangeQuery, response: { 200: paginatedResponseSchema(adminLoginActivityRowSchema) } } },
      async (request) => {
        const { from, to, cursor: cursorRaw, limit } = request.query;
        const cursor = decodeCursor(cursorRaw);
        const conditions = [eq(userActivity.type, 'login')];
        if (from) conditions.push(gte(userActivity.occurredAt, new Date(from)));
        if (to) conditions.push(lte(userActivity.occurredAt, new Date(to)));
        if (cursor) conditions.push(lt(userActivity.occurredAt, new Date(cursor.v)));

        const rows = await fastify.db.query.userActivity.findMany({ where: and(...conditions), orderBy: [desc(userActivity.occurredAt)], limit: limit + 1 });
        return paginated(rows, limit, (r) => ({
          id: r.id,
          userId: r.userId,
          deviceId: r.deviceId,
          type: 'login' as const,
          ip: r.ip,
          metadata: r.metadata,
          occurredAt: r.occurredAt.toISOString(),
        }));
      },
    );

    app.get(
      '/api/v1/admin/activity/errors',
      { onRequest: [gate], schema: { tags: ['admin'], querystring: rangeQuery, response: { 200: paginatedResponseSchema(adminErrorActivityRowSchema) } } },
      async (request) => {
        const { from, to, cursor: cursorRaw, limit } = request.query;
        const cursor = decodeCursor(cursorRaw);
        const conditions = [eq(userActivity.type, 'error')];
        if (from) conditions.push(gte(userActivity.occurredAt, new Date(from)));
        if (to) conditions.push(lte(userActivity.occurredAt, new Date(to)));
        if (cursor) conditions.push(lt(userActivity.occurredAt, new Date(cursor.v)));

        const rows = await fastify.db.query.userActivity.findMany({ where: and(...conditions), orderBy: [desc(userActivity.occurredAt)], limit: limit + 1 });
        return paginated(rows, limit, (r) => ({
          id: r.id,
          userId: r.userId,
          deviceId: r.deviceId,
          type: 'error' as const,
          ip: r.ip,
          metadata: r.metadata,
          occurredAt: r.occurredAt.toISOString(),
        }));
      },
    );

    app.get(
      '/api/v1/admin/activity/searches',
      { onRequest: [gate], schema: { tags: ['admin'], querystring: rangeQuery, response: { 200: paginatedResponseSchema(adminSearchActivityRowSchema) } } },
      async (request) => {
        const { from, to, cursor: cursorRaw, limit } = request.query;
        const cursor = decodeCursor(cursorRaw);
        const conditions = [];
        if (from) conditions.push(gte(searchActivity.occurredAt, new Date(from)));
        if (to) conditions.push(lte(searchActivity.occurredAt, new Date(to)));
        if (cursor) conditions.push(lt(searchActivity.occurredAt, new Date(cursor.v)));

        const rows = await fastify.db.query.searchActivity.findMany({
          where: conditions.length > 0 ? and(...conditions) : undefined,
          orderBy: [desc(searchActivity.occurredAt)],
          limit: limit + 1,
        });
        return paginated(rows, limit, (r) => ({
          id: r.id,
          userId: r.userId,
          deviceId: r.deviceId,
          filterHash: r.filterHash,
          resultsCount: r.resultsCount,
          resourceId: r.resourceId,
          floorPrice: r.floorPrice,
          occurredAt: r.occurredAt.toISOString(),
        }));
      },
    );

    app.get(
      '/api/v1/admin/activity/snipes',
      { onRequest: [gate], schema: { tags: ['admin'], querystring: rangeQuery, response: { 200: paginatedResponseSchema(adminSnipeActivityRowSchema) } } },
      async (request) => {
        const { from, to, cursor: cursorRaw, limit } = request.query;
        const cursor = decodeCursor(cursorRaw);
        const conditions = [];
        if (from) conditions.push(gte(snipingActivity.occurredAt, new Date(from)));
        if (to) conditions.push(lte(snipingActivity.occurredAt, new Date(to)));
        if (cursor) conditions.push(lt(snipingActivity.occurredAt, new Date(cursor.v)));

        const rows = await fastify.db.query.snipingActivity.findMany({
          where: conditions.length > 0 ? and(...conditions) : undefined,
          orderBy: [desc(snipingActivity.occurredAt)],
          limit: limit + 1,
        });
        return paginated(rows, limit, (r) => ({
          id: r.id,
          userId: r.userId,
          deviceId: r.deviceId,
          resourceId: r.resourceId,
          tradeId: r.tradeId,
          targetPrice: r.targetPrice,
          listedPrice: r.listedPrice,
          outcome: r.outcome,
          latencyMs: r.latencyMs,
          errorCode: r.errorCode,
          occurredAt: r.occurredAt.toISOString(),
        }));
      },
    );

    app.get(
      '/api/v1/admin/activity/devices',
      {
        onRequest: [gate],
        schema: { tags: ['admin'], response: { 200: adminActivityDevicesSummarySchema } },
      },
      async () => {
        const rows = await fastify.db.query.devices.findMany({ where: eq(devices.status, 'active') });
        const byVersion: Record<string, number> = {};
        const byOs: Record<string, number> = {};
        for (const d of rows) {
          const v = d.extensionVersion ?? 'unknown';
          const o = d.os ?? 'unknown';
          byVersion[v] = (byVersion[v] ?? 0) + 1;
          byOs[o] = (byOs[o] ?? 0) + 1;
        }
        return { byVersion, byOs, total: rows.length };
      },
    );

    app.get(
      '/api/v1/admin/activity/ips',
      {
        onRequest: [gate],
        schema: {
          tags: ['admin'],
          querystring: z.object({ flaggedOnly: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(500).default(100) }),
          response: { 200: z.array(adminIpActivityRowSchema) },
        },
      },
      async (request) => {
        const rows = await fastify.db.query.ipActivity.findMany({
          where: request.query.flaggedOnly ? eq(ipActivity.flagged, true) : undefined,
          orderBy: [desc(ipActivity.lastSeen)],
          limit: request.query.limit,
        });
        return rows.map((r) => ({
          ip: r.ip,
          userId: r.userId,
          country: r.country,
          asn: r.asn,
          firstSeen: r.firstSeen.toISOString(),
          lastSeen: r.lastSeen.toISOString(),
          requestCount: r.requestCount,
          flagged: r.flagged,
        }));
      },
    );
  },
  { name: 'module:admin-activity', dependencies: ['auth', 'db'] },
);

function paginated<Row extends { id: string; occurredAt: Date }, Dto extends { id: string; occurredAt: string }>(
  rows: Row[],
  limit: number,
  toDto: (row: Row) => Dto,
) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(toDto);
  const last = page.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ v: last.occurredAt.toISOString(), id: last.id }) : null,
  };
}
