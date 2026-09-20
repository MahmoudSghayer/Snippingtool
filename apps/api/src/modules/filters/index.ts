// /api/v1/filters — saved filter CRUD + POST /filters/stats batch upsert
// (the ranker's realised-return history, synced from the extension).

import { createHash } from 'node:crypto';


import { filterStats, savedFilters } from '@sl/db';
import {
  createSavedFilterRequestSchema,
  reportFilterStatsRequestSchema,
  savedFilterSchema,
  updateSavedFilterRequestSchema,
  type SavedFilter,
} from '@sl/shared';
import { and, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function filterHash(filter: unknown): string {
  return createHash('sha256').update(JSON.stringify(filter)).digest('hex');
}

function toDto(row: typeof savedFilters.$inferSelect): SavedFilter {
  return {
    id: row.id,
    name: row.name,
    filter: row.filter as SavedFilter['filter'],
    filterHash: row.filterHash,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

export default fp(
  async function filtersModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/filters',
      { onRequest: [fastify.authenticate], schema: { tags: ['filters'], response: { 200: z.array(savedFilterSchema) } } },
      async (request) => {
        const rows = await fastify.db.query.savedFilters.findMany({
          where: and(eq(savedFilters.userId, request.authUser!.id), isNull(savedFilters.deletedAt)),
        });
        return rows.map(toDto);
      },
    );

    app.post(
      '/api/v1/filters',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['filters'], body: createSavedFilterRequestSchema, response: { 201: savedFilterSchema } },
      },
      async (request, reply) => {
        const id = newId();
        const hash = filterHash(request.body.filter);
        await fastify.db.insert(savedFilters).values({
          id,
          userId: request.authUser!.id,
          name: request.body.name,
          filter: request.body.filter,
          filterHash: hash,
        });
        reply.status(201);
        const row = await fastify.db.query.savedFilters.findFirst({ where: eq(savedFilters.id, id) });
        return toDto(row!);
      },
    );

    app.patch(
      '/api/v1/filters/:id',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['filters'], params: z.object({ id: z.string().uuid() }), body: updateSavedFilterRequestSchema, response: { 200: savedFilterSchema } },
      },
      async (request) => {
        const existing = await fastify.db.query.savedFilters.findFirst({
          where: and(eq(savedFilters.id, request.params.id), eq(savedFilters.userId, request.authUser!.id), isNull(savedFilters.deletedAt)),
        });
        if (!existing) throw AppErrors.notFound('filter');

        const [updated] = await fastify.db
          .update(savedFilters)
          .set({
            name: request.body.name ?? existing.name,
            filter: request.body.filter ?? existing.filter,
            filterHash: request.body.filter ? filterHash(request.body.filter) : existing.filterHash,
            isActive: request.body.isActive ?? existing.isActive,
            sortOrder: request.body.sortOrder ?? existing.sortOrder,
          })
          .where(eq(savedFilters.id, existing.id))
          .returning();

        return toDto(updated!);
      },
    );

    app.delete(
      '/api/v1/filters/:id',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['filters'], params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ deleted: z.literal(true) }) } },
      },
      async (request) => {
        const existing = await fastify.db.query.savedFilters.findFirst({
          where: and(eq(savedFilters.id, request.params.id), eq(savedFilters.userId, request.authUser!.id), isNull(savedFilters.deletedAt)),
        });
        if (!existing) throw AppErrors.notFound('filter');
        await fastify.db.update(savedFilters).set({ deletedAt: new Date() }).where(eq(savedFilters.id, existing.id));
        return { deleted: true as const };
      },
    );

    app.post(
      '/api/v1/filters/stats',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['filters'], body: reportFilterStatsRequestSchema, response: { 200: z.object({ upserted: z.number() }) } },
      },
      async (request) => {
        let upserted = 0;
        for (const stat of request.body.stats) {
          const filter = await fastify.db.query.savedFilters.findFirst({
            where: and(eq(savedFilters.id, stat.filterId), eq(savedFilters.userId, request.authUser!.id)),
          });
          if (!filter) continue; // silently skip stats for filters that no longer belong to this user

          const windowStart = new Date(stat.windowStart);
          const existing = await fastify.db.query.filterStats.findFirst({
            where: and(eq(filterStats.filterId, filter.id), eq(filterStats.windowStart, windowStart)),
          });

          const values = {
            searches: stat.searches,
            attempts: stat.attempts,
            successes: stat.successes,
            coinsSpent: stat.coinsSpent,
            coinsEarned: stat.coinsEarned,
            coinsPerHour: String(stat.coinsPerHour),
          };

          if (existing) {
            await fastify.db.update(filterStats).set(values).where(eq(filterStats.id, existing.id));
          } else {
            await fastify.db.insert(filterStats).values({ id: newId(), filterId: filter.id, windowStart, ...values });
          }
          upserted++;
        }
        return { upserted };
      },
    );
  },
  { name: 'module:filters', dependencies: ['auth', 'db'] },
);
