// /api/v1/trades — batch upsert from the extension, a cursor-paginated list
// for the dashboard, and `POST /trades/:id/close` for recording a sale.
//
// The API owns the profit maths. Whatever a client sends for `eaTax` and
// `netProfit`, a stored trade's tax and net are recomputed here from its
// buy and sell prices with `@sl/shared`'s `computeTradeProfit`, so the
// dashboard's figures can never be inflated (or tax-free) by a client. Every
// write also rolls the affected `(user, day)` profit rows up immediately
// (lib/analytics/rollup.ts) so the dashboard reflects it on its next
// request rather than after the hourly job.

import { trades, type Database } from '@sl/db';
import {
  closeTradeRequestSchema,
  computeTradeProfit,
  paginatedResponseSchema,
  paginationQuerySchema,
  reportTradesRequestSchema,
  type ReportTradesRequest,
  tradeSchema,
  type Trade,
} from '@sl/shared';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { rollupProfitsForUserDays, utcDay } from '../../lib/analytics/rollup.js';
import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { INGEST_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

type TradeRow = typeof trades.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Serialises one user's trade writes (batch and close) for the rest of
 * the transaction. Each write reads a trade's previous days before moving
 * it, so its old day can be re-rolled; without this, two writes to the
 * same trade could each read the old days and one move would leave a
 * stale day behind. Taken before any rollup lock, always, so the two
 * kinds of lock are acquired in one order. */
async function lockUserTrades(tx: Database, userId: string): Promise<void> {
  await tx.execute(
    sql.join([
      sql`SELECT pg_advisory_xact_lock(hashtextextended(`,
      sql.param(`trades:${userId}`),
      sql`, 0))`,
    ]),
  );
}

/** Tax and net for a stored row: derived from prices whenever a sale price
 * is known, `null` while the card is still in flight. */
function profitColumns(
  buyPrice: number,
  sellPrice: number | null,
): { eaTax: number | null; netProfit: number | null } {
  if (sellPrice == null) return { eaTax: null, netProfit: null };
  const { eaTaxCoins, netProfit } = computeTradeProfit(buyPrice, sellPrice);
  return { eaTax: eaTaxCoins, netProfit };
}

/** Days whose `profits` row a trade contributes to: its purchase day and,
 * once sold, its sale day. */
function touchedDays(row: { boughtAt: Date | null; soldAt: Date | null }): string[] {
  const days: string[] = [];
  if (row.boughtAt) days.push(utcDay(row.boughtAt));
  if (row.soldAt) days.push(utcDay(row.soldAt));
  return days;
}

const TERMINAL_STATUSES: ReadonlySet<TradeRow['status']> = new Set(['sold', 'expired', 'unsold']);

/** Column values for a batch-reported trade. The extension reports the
 * sales it sees on the trade pile (status `sold`, on the buy's tradeId),
 * but not a sale it missed, so its local copy of a trade can still say
 * `bought` after the dashboard recorded the sale with `/close`. A report
 * that would move a finished trade back to `bought`/`listed` keeps the
 * stored sale instead of erasing it. */
function batchValues(t: ReportTradesRequest['trades'][number], existing: TradeRow | undefined) {
  const buySide = {
    tradeId: t.tradeId,
    resourceId: String(t.resourceId),
    assetId: t.assetId != null ? String(t.assetId) : null,
    rating: t.rating,
    buyPrice: t.buyPrice,
    boughtAt: new Date(t.boughtAt),
  };

  if (existing && TERMINAL_STATUSES.has(existing.status) && !TERMINAL_STATUSES.has(t.status)) {
    // The stored sale stands, so the purchase must still precede it: a
    // stale report whose purchase time is after the recorded sale keeps the
    // stored purchase time (trades_sold_after_bought would otherwise 500
    // the whole batch). Not a 400: the extension cannot fix a report the
    // dashboard's /close made stale, and rejecting it would fail every other
    // trade in the batch with it.
    // A stored purchase time of null stays null: trades_sold_after_bought
    // accepts a NULL bought_at, and the reported one is after the sale.
    const boughtAt: Date | null =
      existing.soldAt && buySide.boughtAt > existing.soldAt ? existing.boughtAt : buySide.boughtAt;
    return {
      ...buySide,
      boughtAt,
      status: existing.status,
      sellPrice: existing.sellPrice,
      soldAt: existing.soldAt,
      ...profitColumns(t.buyPrice, existing.sellPrice),
    };
  }

  return {
    ...buySide,
    status: t.status,
    sellPrice: t.sellPrice,
    soldAt: t.soldAt ? new Date(t.soldAt) : null,
    ...profitColumns(t.buyPrice, t.sellPrice),
  };
}

function toTradeDto(t: TradeRow): Trade {
  return {
    id: t.id,
    tradeId: t.tradeId,
    resourceId: Number(t.resourceId),
    assetId: t.assetId ? Number(t.assetId) : null,
    rating: t.rating,
    buyPrice: t.buyPrice ?? 0,
    sellPrice: t.sellPrice,
    // The wire format carries the tax as the 0-1 rate that was applied; the
    // column holds integer coins.
    eaTax: t.sellPrice && t.eaTax ? t.eaTax / t.sellPrice : 0,
    netProfit: t.netProfit,
    status: t.status,
    boughtAt: t.boughtAt ? t.boughtAt.toISOString() : new Date(0).toISOString(),
    soldAt: t.soldAt ? t.soldAt.toISOString() : null,
  };
}

export default fp(
  async function tradesModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/trades/batch',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: INGEST_RATE_LIMIT },
        schema: {
          tags: ['trades'],
          body: reportTradesRequestSchema,
          response: { 200: z.object({ upserted: z.number() }) },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        // `trades_sold_after_bought` would otherwise fail the whole batch
        // with a 500; say which trade is wrong instead.
        const inverted = request.body.trades.find(
          (t) => t.soldAt != null && Date.parse(t.soldAt) < Date.parse(t.boughtAt),
        );
        if (inverted)
          throw AppErrors.validation('A trade cannot be sold before it was bought.', {
            tradeId: inverted.tradeId,
          });

        // A batch may report the same trade more than once (the extension
        // re-queues on a failed flush); the last report wins.
        const latest = new Map(request.body.trades.map((t) => [t.tradeId, t]));

        await fastify.db.transaction(async (tx) => {
          // Serialise this user's trade writes: two overlapping batches that
          // both see a new tradeId as absent would otherwise both insert it
          // and one would 500 on the live unique index.
          await lockUserTrades(tx, userId);

          const affected: { userId: string; day: string }[] = [];
          const existingRows = await tx.query.trades.findMany({
            where: and(
              eq(trades.userId, userId),
              inArray(trades.tradeId, [...latest.keys()]),
              isNull(trades.deletedAt),
            ),
          });
          const existingByTradeId = new Map(existingRows.map((r) => [r.tradeId, r]));

          const inserts: (typeof trades.$inferInsert)[] = [];
          for (const t of latest.values()) {
            const existing = existingByTradeId.get(t.tradeId);
            const values = batchValues(t, existing);

            if (existing) {
              // The row's previous days need re-rolling too, in case the
              // client moved or removed its sale.
              for (const day of touchedDays(existing)) affected.push({ userId, day });
              await tx.update(trades).set(values).where(eq(trades.id, existing.id));
            } else {
              inserts.push({ id: newId(), userId, ...values });
            }
            for (const day of touchedDays(values)) affected.push({ userId, day });
          }
          if (inserts.length > 0) await tx.insert(trades).values(inserts);

          // In the same transaction, so the rollup sees exactly what this
          // batch wrote and a failure leaves neither half behind.
          await rollupProfitsForUserDays(tx, affected);
        });

        return { upserted: latest.size };
      },
    );

    app.post(
      '/api/v1/trades/:id/close',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['trades'],
          params: z.object({ id: z.string().uuid() }),
          body: closeTradeRequestSchema,
          response: { 200: tradeSchema },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        return fastify.db.transaction(async (tx) => {
          await lockUserTrades(tx, userId);
          const existing = await tx.query.trades.findFirst({
            where: and(
              eq(trades.id, request.params.id),
              eq(trades.userId, userId),
              isNull(trades.deletedAt),
            ),
          });
          if (!existing) throw AppErrors.notFound('trade');
          if (existing.status === 'sold')
            throw AppErrors.conflict('This trade is already recorded as sold.', {
              soldAt: existing.soldAt?.toISOString() ?? null,
            });

          const soldAt = request.body.soldAt ? new Date(request.body.soldAt) : new Date();
          if (existing.boughtAt && soldAt < existing.boughtAt)
            throw AppErrors.validation('A trade cannot be sold before it was bought.', {
              boughtAt: existing.boughtAt.toISOString(),
            });

          const [updated] = await tx
            .update(trades)
            .set({
              status: 'sold',
              sellPrice: request.body.sellPrice,
              soldAt,
              ...profitColumns(existing.buyPrice ?? 0, request.body.sellPrice),
            })
            .where(eq(trades.id, existing.id))
            .returning();

          await rollupProfitsForUserDays(
            tx,
            touchedDays(updated!).map((day) => ({ userId, day })),
          );
          return toTradeDto(updated!);
        });
      },
    );

    app.get(
      '/api/v1/trades',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['trades'],
          querystring: paginationQuerySchema,
          response: { 200: paginatedResponseSchema(tradeSchema) },
        },
      },
      async (request) => {
        const cursor = decodeCursor(request.query.cursor);
        const limit = request.query.limit;
        const userId = request.authUser!.id;

        // Keyset on (bought_at, id), newest first. Comparing bought_at alone
        // skipped every row that shared the last row's timestamp — the
        // extension can report several buys in the same millisecond.
        const conditions = [eq(trades.userId, userId), isNull(trades.deletedAt)];
        if (cursor) {
          const at = new Date(cursor.v);
          if (Number.isNaN(at.getTime()) || !UUID_RE.test(cursor.id))
            throw AppErrors.validation('Invalid cursor.');
          conditions.push(
            or(lt(trades.boughtAt, at), and(eq(trades.boughtAt, at), lt(trades.id, cursor.id)))!,
          );
        }

        const rows = await fastify.db.query.trades.findMany({
          where: and(...conditions),
          orderBy: [desc(trades.boughtAt), desc(trades.id)],
          limit: limit + 1,
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1);

        return {
          items: items.map(toTradeDto),
          nextCursor:
            hasMore && last?.boughtAt
              ? encodeCursor({ v: last.boughtAt.toISOString(), id: last.id })
              : null,
        };
      },
    );
  },
  { name: 'module:trades', dependencies: ['auth', 'db'] },
);
