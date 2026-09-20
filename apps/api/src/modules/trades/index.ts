// /api/v1/trades — batch upsert from the extension, and a cursor-paginated
// list for the dashboard.


import { trades } from '@sl/db';
import { paginatedResponseSchema, paginationQuerySchema, reportTradesRequestSchema, tradeSchema } from '@sl/shared';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { newId } from '../../lib/ids.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export default fp(
  async function tradesModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/trades/batch',
      {
        onRequest: [fastify.authenticate],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: { tags: ['trades'], body: reportTradesRequestSchema, response: { 200: z.object({ upserted: z.number() }) } },
      },
      async (request) => {
        const userId = request.authUser!.id;
        let upserted = 0;

        for (const t of request.body.trades) {
          const existing = await fastify.db.query.trades.findFirst({
            where: and(eq(trades.userId, userId), eq(trades.tradeId, t.tradeId), isNull(trades.deletedAt)),
          });

          // ea_tax is stored as an integer coin amount (repo convention:
          // money/coins are always integer, never float); the client sends a
          // fractional rate (0-1) applied against the sale.
          const eaTaxCoins = t.sellPrice != null ? Math.round(t.sellPrice * t.eaTax) : null;

          const values = {
            tradeId: t.tradeId,
            resourceId: String(t.resourceId),
            assetId: t.assetId != null ? String(t.assetId) : null,
            rating: t.rating,
            buyPrice: t.buyPrice,
            sellPrice: t.sellPrice,
            eaTax: eaTaxCoins,
            netProfit: t.netProfit,
            status: t.status,
            boughtAt: new Date(t.boughtAt),
            soldAt: t.soldAt ? new Date(t.soldAt) : null,
          };

          if (existing) {
            await fastify.db.update(trades).set(values).where(eq(trades.id, existing.id));
          } else {
            await fastify.db.insert(trades).values({ id: newId(), userId, ...values });
          }
          upserted++;
        }

        return { upserted };
      },
    );

    app.get(
      '/api/v1/trades',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['trades'], querystring: paginationQuerySchema, response: { 200: paginatedResponseSchema(tradeSchema) } },
      },
      async (request) => {
        const cursor = decodeCursor(request.query.cursor);
        const limit = request.query.limit;
        const userId = request.authUser!.id;

        const rows = await fastify.db.query.trades.findMany({
          where: cursor
            ? and(eq(trades.userId, userId), isNull(trades.deletedAt), lt(trades.boughtAt, new Date(cursor.v)))
            : and(eq(trades.userId, userId), isNull(trades.deletedAt)),
          orderBy: [desc(trades.boughtAt)],
          limit: limit + 1,
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1);

        return {
          items: items.map((t) => ({
            id: t.id,
            tradeId: t.tradeId,
            resourceId: Number(t.resourceId),
            assetId: t.assetId ? Number(t.assetId) : null,
            rating: t.rating,
            buyPrice: t.buyPrice ?? 0,
            sellPrice: t.sellPrice,
            eaTax: t.sellPrice && t.eaTax ? t.eaTax / t.sellPrice : 0,
            netProfit: t.netProfit,
            status: t.status,
            boughtAt: t.boughtAt ? t.boughtAt.toISOString() : new Date(0).toISOString(),
            soldAt: t.soldAt ? t.soldAt.toISOString() : null,
          })),
          nextCursor: hasMore && last?.boughtAt ? encodeCursor({ v: last.boughtAt.toISOString(), id: last.id }) : null,
        };
      },
    );
  },
  { name: 'module:trades', dependencies: ['auth', 'db'] },
);
