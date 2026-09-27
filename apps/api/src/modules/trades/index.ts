// /api/v1/trades — batch upsert from the extension, a cursor-paginated list
// for the dashboard (with its totals and CSV export over the same filters),
// and `POST /trades/:id/close` for recording a sale.
//
// The API owns the profit maths. Whatever a client sends for `eaTax` and
// `netProfit`, a stored trade's tax and net are recomputed here from its
// buy and sell prices with `@sl/shared`'s `computeTradeProfit`, so the
// dashboard's figures can never be inflated (or tax-free) by a client. Every
// write also rolls the affected `(user, day)` profit rows up immediately
// (lib/analytics/rollup.ts) so the dashboard reflects it on its next
// request rather than after the hourly job.

import { cards, trades, type Database } from '@sl/db';
import {
  closeTradeRequestSchema,
  computeTradeProfit,
  paginatedResponseSchema,
  reportTradesRequestSchema,
  type ReportTradesRequest,
  tradeFilterQuerySchema,
  type TradeFilterQuery,
  tradeListItemSchema,
  type TradeListItem,
  tradeListQuerySchema,
  tradeSchema,
  tradeTotalsSchema,
  type Trade,
} from '@sl/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { csvStream } from '../../lib/analytics/csv.js';
import { rollupProfitsForUserDays, utcDay } from '../../lib/analytics/rollup.js';
import { CURRENT_FC_TITLE } from '../../lib/collectors/resolver.js';
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

  // A stored sale also stands against a later `sold` report: the
  // dashboard's /close is the trader's own word on the price, and the
  // extension's report (seen on the trade pile) must not overwrite it. An
  // identical re-send changes nothing either way; `expired`/`unsold` can
  // still move to `sold`.
  if (
    existing &&
    TERMINAL_STATUSES.has(existing.status) &&
    (existing.status === 'sold' || !TERMINAL_STATUSES.has(t.status))
  ) {
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

/** The instant a calendar day starts in `tz` (`'2026-09-10'` in
 * `Asia/Tokyo` is 2026-09-09T15:00Z), as SQL. `tz` is an IANA name already
 * checked by `timeZoneSchema`. */
function startOfDayIn(day: string, tz: string, plusDays = 0): SQL {
  return sql.join([
    sql`((`,
    sql.param(day),
    sql`::date + `,
    sql.param(plusDays),
    sql`::int)::timestamp AT TIME ZONE `,
    sql.param(tz),
    sql`)`,
  ]);
}

/** WHERE conditions for one user's live trades matching the dashboard's
 * filters: status, and purchase day within [from, to] in `tz`. */
function filterConditions(userId: string, filter: TradeFilterQuery): SQL[] {
  if (filter.from && filter.to && filter.from > filter.to)
    throw AppErrors.validation('`from` must be on or before `to`.');
  const conditions: SQL[] = [eq(trades.userId, userId), isNull(trades.deletedAt)];
  if (filter.status) conditions.push(eq(trades.status, filter.status));
  if (filter.from) conditions.push(gte(trades.boughtAt, startOfDayIn(filter.from, filter.tz)));
  if (filter.to) conditions.push(lt(trades.boughtAt, startOfDayIn(filter.to, filter.tz, 1)));
  return conditions;
}

/** The card a trade is for, in the current FC title: EA reuses resource ids
 * across titles (lib/collectors/resolver.ts), so an older title's card
 * would put the wrong name on the row. */
const cardJoin = and(eq(cards.resourceId, trades.resourceId), eq(cards.fcTitle, CURRENT_FC_TITLE));

const listColumns = {
  trade: trades,
  // The name traders know a card by (`Messi`), else the full name.
  cardName: sql
    .join([sql`coalesce(`, cards.commonName, sql`, `, cards.name, sql`)`])
    .mapWith((v: string | null) => v),
  cardRating: cards.rating,
};

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

function toListItem(row: {
  trade: TradeRow;
  cardName: string | null;
  cardRating: number | null;
}): TradeListItem {
  const dto = toTradeDto(row.trade);
  return { ...dto, rating: dto.rating ?? row.cardRating, cardName: row.cardName };
}

/** A spreadsheet runs a cell starting with one of these as a formula. Card
 * names come from scraped sources, so they're neutralised with a leading
 * quote (OWASP "CSV injection"). */
function csvText(value: string | null): string | null {
  return value && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export default fp(
  async function tradesModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/trades/batch',
      {
        onRequest: [fastify.requireFeature('ledger.recorder')],
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
        onRequest: [fastify.requireFeature('ledger.recorder')],
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

    /** One keyset page of the caller's filtered trades, with card names.
     * Keyset on (bought_at, id) in the requested direction. Comparing
     * bought_at alone skipped every row that shared the last row's
     * timestamp — the extension can report several buys in the same
     * millisecond. */
    async function listPage(
      userId: string,
      filter: TradeFilterQuery,
      order: 'asc' | 'desc',
      after: { at: Date; id: string } | null,
      limit: number,
    ) {
      const conditions = filterConditions(userId, filter);
      const past = order === 'asc' ? gt : lt;
      if (after)
        conditions.push(
          or(
            past(trades.boughtAt, after.at),
            and(eq(trades.boughtAt, after.at), past(trades.id, after.id)),
          )!,
        );
      const direction = order === 'asc' ? asc : desc;
      return fastify.db
        .select(listColumns)
        .from(trades)
        .leftJoin(cards, cardJoin)
        .where(and(...conditions))
        .orderBy(direction(trades.boughtAt), direction(trades.id))
        .limit(limit);
    }

    app.get(
      '/api/v1/trades',
      {
        onRequest: [fastify.requireFeature('ledger.recorder')],
        schema: {
          tags: ['trades'],
          querystring: tradeListQuerySchema,
          response: { 200: paginatedResponseSchema(tradeListItemSchema) },
        },
      },
      async (request) => {
        const cursor = decodeCursor(request.query.cursor);
        const { limit, order } = request.query;
        let after: { at: Date; id: string } | null = null;
        if (cursor) {
          const at = new Date(cursor.v);
          if (Number.isNaN(at.getTime()) || !UUID_RE.test(cursor.id))
            throw AppErrors.validation('Invalid cursor.');
          after = { at, id: cursor.id };
        }

        const rows = await listPage(request.authUser!.id, request.query, order, after, limit + 1);
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1)?.trade;

        return {
          items: items.map(toListItem),
          nextCursor:
            hasMore && last?.boughtAt
              ? encodeCursor({ v: last.boughtAt.toISOString(), id: last.id })
              : null,
        };
      },
    );

    // Totals for the same filters as the list, over every matching trade
    // rather than the page on screen. Coins spent count every purchase;
    // revenue and net count sales (a trade with a sale time), the same
    // attribution as the `profits` rollup (lib/analytics/rollup.ts).
    app.get(
      '/api/v1/trades/totals',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['trades'],
          querystring: tradeFilterQuerySchema,
          response: { 200: tradeTotalsSchema },
        },
      },
      async (request) => {
        const [row] = await fastify.db
          .select({
            count: sql`count(*)::int`.mapWith(Number),
            sold: sql`(count(*) FILTER (WHERE sold_at IS NOT NULL))::int`.mapWith(Number),
            spent: sql`coalesce(sum(buy_price), 0)::bigint`.mapWith(Number),
            revenue:
              sql`coalesce(sum(sell_price) FILTER (WHERE sold_at IS NOT NULL), 0)::bigint`.mapWith(
                Number,
              ),
            netProfit:
              sql`coalesce(sum(net_profit) FILTER (WHERE sold_at IS NOT NULL), 0)::bigint`.mapWith(
                Number,
              ),
          })
          .from(trades)
          .where(and(...filterConditions(request.authUser!.id, request.query)));
        return row!;
      },
    );

    // Every trade matching the list's filters as CSV, newest first, streamed
    // a page at a time (same pattern as /admin/audit/export.csv).
    app.get(
      '/api/v1/trades/export.csv',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['trades'],
          summary: "Stream the caller's trades matching the given filters as CSV.",
          querystring: tradeFilterQuerySchema,
        },
      },
      async (request, reply) => {
        const userId = request.authUser!.id;
        const filter = request.query;
        // Throws a 400 for a bad range before any bytes are streamed.
        filterConditions(userId, filter);

        const PAGE_SIZE = 1000;
        async function* rows() {
          let after: { at: Date; id: string } | null = null;
          for (;;) {
            const page = await listPage(userId, filter, 'desc', after, PAGE_SIZE);
            for (const row of page) {
              const t = toListItem(row);
              yield {
                tradeId: t.tradeId,
                card: csvText(t.cardName ?? `#${t.resourceId}`),
                resourceId: t.resourceId,
                rating: t.rating,
                status: t.status,
                buyPrice: t.buyPrice,
                sellPrice: t.sellPrice,
                eaTax: row.trade.eaTax,
                netProfit: t.netProfit,
                boughtAt: row.trade.boughtAt?.toISOString() ?? null,
                soldAt: t.soldAt,
              };
            }
            const last = page.at(-1)?.trade;
            // A trade with no purchase time sorts first and can't be a keyset
            // position; only the extension's very first builds wrote one.
            if (page.length < PAGE_SIZE || !last?.boughtAt) return;
            after = { at: last.boughtAt, id: last.id };
          }
        }

        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="trades.csv"');
        return reply.send(
          csvStream(
            [
              { key: 'tradeId', header: 'tradeId' },
              { key: 'card', header: 'card' },
              { key: 'resourceId', header: 'resourceId' },
              { key: 'rating', header: 'rating' },
              { key: 'status', header: 'status' },
              { key: 'buyPrice', header: 'buyPrice' },
              { key: 'sellPrice', header: 'sellPrice' },
              { key: 'eaTax', header: 'eaTax' },
              { key: 'netProfit', header: 'netProfit' },
              { key: 'boughtAt', header: 'boughtAt' },
              { key: 'soldAt', header: 'soldAt' },
            ],
            rows(),
          ),
        );
      },
    );
  },
  { name: 'module:trades', dependencies: ['auth', 'db'] },
);
