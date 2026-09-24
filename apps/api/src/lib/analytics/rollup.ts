// Profit rollup: recomputes one `(user, UTC day)` row of the `profits`
// table from `trades` + `sniping_activity`. Always re-derives the whole day
// (idempotent upsert) rather than incrementing, so a late batch from the
// extension, a re-run, or a corrected sale price all converge on the same
// numbers.
//
// Two callers share it:
//   - the ingest routes (`POST /trades/batch`, `POST /trades/:id/close`,
//     `POST /sniping/attempts`) call it synchronously for every day their
//     write touched, so the dashboard reflects a logged trade on the very
//     next request instead of after the hourly job;
//   - the `profits.rollup` job sweeps today and yesterday for every active
//     user as a self-healing backstop.
//
// Race-freedom: the recompute is one `INSERT … SELECT sum()/count() … ON
// CONFLICT (user_id, day) DO UPDATE` statement, so two ingests creating the
// same new day can no longer both try to INSERT and 500 on
// `profits_user_id_day_unique`. It must run inside the caller's
// transaction, after the caller's own write: it first takes a
// transaction-scoped advisory lock on `(user, day)`, so a concurrent trade
// ingest and sniping ingest for the same day take turns, and the second
// one's aggregate (a fresh READ COMMITTED snapshot, taken after the lock)
// sees the first one's committed rows. Without the lock the second upsert
// could overwrite the row with totals that miss the first ingest's rows.
// Keys are locked in sorted order so two transactions touching the same
// days can never deadlock on each other.
//
// Day attribution (also documented in docs/08-analytics.md): coins spent
// and snipes count on the day the purchase/attempt happened; coins earned,
// net profit and closed trades count on the day the sale happened.

import { snipingActivity, trades, type Database } from '@sl/db';
import { and, gte, isNull, lt, or, sql } from 'drizzle-orm';

import { newId } from '../ids.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of an instant in UTC — the bucket key the `profits` table
 * and every analytics query use. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export interface ProfitDayTotals {
  coinsSpent: number;
  coinsEarned: number;
  netProfit: number;
  snipes: number;
  successes: number;
  tradesClosed: number;
}

const ZERO_TOTALS: ProfitDayTotals = {
  coinsSpent: 0,
  coinsEarned: 0,
  netProfit: 0,
  snipes: 0,
  successes: 0,
  tradesClosed: 0,
};

/** Recomputes and upserts the `profits` row for one user on one UTC day,
 * entirely in SQL. Returns the totals written (zeros when there was nothing
 * to write). A day with no activity at all still gets a zero row if one
 * already existed (so a deleted/corrected trade zeroes it out rather than
 * leaving stale numbers behind), but a day that never had a row does not
 * get an empty one. Call it inside a transaction: see this file's header. */
export async function rollupProfitsForUserDay(
  tx: Database,
  userId: string,
  day: string,
): Promise<ProfitDayTotals> {
  const { start, end } = dayBounds(day);
  // Built the way the repo requires (packages/config/eslint-preset.js):
  // constant SQL chunks joined with separately bound params, never a value
  // interpolated into a `sql` template.
  const u = () => sql.param(userId);
  const from = () => sql.param(start.toISOString());
  const to = () => sql.param(end.toISOString());
  const d = () => sql.param(day);

  await tx.execute(
    sql.join([
      sql`SELECT pg_advisory_xact_lock(hashtextextended(`,
      sql.param(`profits:${userId}:${day}`),
      sql`, 0))`,
    ]),
  );

  const rows = (await tx.execute(
    sql.join([
      sql`WITH bought AS (
         SELECT coalesce(sum(buy_price), 0)::bigint AS coins_spent, count(*)::int AS n
           FROM trades
          WHERE user_id = `,
      u(),
      sql`::uuid AND deleted_at IS NULL AND bought_at >= `,
      from(),
      sql`::timestamptz AND bought_at < `,
      to(),
      sql`::timestamptz
       ), sold AS (
         SELECT coalesce(sum(sell_price), 0)::bigint AS coins_earned,
                coalesce(sum(net_profit), 0)::bigint AS net_profit,
                count(*)::int AS n
           FROM trades
          WHERE user_id = `,
      u(),
      sql`::uuid AND deleted_at IS NULL AND sold_at >= `,
      from(),
      sql`::timestamptz AND sold_at < `,
      to(),
      sql`::timestamptz
       ), snipes AS (
         SELECT count(*)::int AS n,
                (count(*) FILTER (WHERE outcome = 'success'))::int AS successes
           FROM sniping_activity
          WHERE user_id = `,
      u(),
      sql`::uuid AND occurred_at >= `,
      from(),
      sql`::timestamptz AND occurred_at < `,
      to(),
      sql`::timestamptz
       )
       INSERT INTO profits
         (id, user_id, day, coins_spent, coins_earned, net_profit, snipes, successes, trades_closed)
       SELECT `,
      sql.param(newId()),
      sql`::uuid, `,
      u(),
      sql`::uuid, `,
      d(),
      sql`::date, bought.coins_spent, sold.coins_earned, sold.net_profit,
              snipes.n, snipes.successes, sold.n
         FROM bought, sold, snipes
        WHERE bought.n + sold.n + snipes.n > 0
           OR EXISTS (SELECT 1 FROM profits p WHERE p.user_id = `,
      u(),
      sql`::uuid AND p.day = `,
      d(),
      sql`::date)
       ON CONFLICT (user_id, day) DO UPDATE SET
         coins_spent = EXCLUDED.coins_spent,
         coins_earned = EXCLUDED.coins_earned,
         net_profit = EXCLUDED.net_profit,
         snipes = EXCLUDED.snipes,
         successes = EXCLUDED.successes,
         trades_closed = EXCLUDED.trades_closed
       RETURNING coins_spent, coins_earned, net_profit, snipes, successes, trades_closed`,
    ]),
  )) as unknown as Array<Record<string, string | number>>;

  const [row] = rows;
  if (!row) return { ...ZERO_TOTALS };
  // bigint columns come back as strings from postgres-js.
  return {
    coinsSpent: Number(row.coins_spent),
    coinsEarned: Number(row.coins_earned),
    netProfit: Number(row.net_profit),
    snipes: Number(row.snipes),
    successes: Number(row.successes),
    tradesClosed: Number(row.trades_closed),
  };
}

/** Recomputes the `profits` row for every `(user, day)` pair in `keys`,
 * inside the caller's transaction. Deduplicates, so a batch touching the
 * same day many times rolls it up once, and goes in sorted order so the
 * advisory locks are always taken in the same order. */
export async function rollupProfitsForUserDays(
  tx: Database,
  keys: Iterable<{ userId: string; day: string }>,
): Promise<number> {
  const unique = new Map<string, { userId: string; day: string }>();
  for (const k of keys) unique.set(`${k.userId}|${k.day}`, k);
  const sorted = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, { userId, day }] of sorted) {
    await rollupProfitsForUserDay(tx, userId, day);
  }
  return sorted.length;
}

/** Every user with a purchase, sale or snipe attempt on `day`, rolled up,
 * each in its own short transaction. Used by the hourly `profits.rollup`
 * job for today and yesterday. */
export async function rollupProfitsForDay(db: Database, day: string): Promise<number> {
  const { start, end } = dayBounds(day);
  const [traders, snipers] = await Promise.all([
    db
      .selectDistinct({ userId: trades.userId })
      .from(trades)
      .where(
        and(
          isNull(trades.deletedAt),
          or(
            and(gte(trades.soldAt, start), lt(trades.soldAt, end)),
            and(gte(trades.boughtAt, start), lt(trades.boughtAt, end)),
          ),
        ),
      ),
    db
      .selectDistinct({ userId: snipingActivity.userId })
      .from(snipingActivity)
      .where(and(gte(snipingActivity.occurredAt, start), lt(snipingActivity.occurredAt, end))),
  ]);
  const userIds = [...new Set([...traders, ...snipers].map((r) => r.userId))].sort();
  for (const userId of userIds) {
    await db.transaction((tx) => rollupProfitsForUserDay(tx as unknown as Database, userId, day));
  }
  return userIds.length;
}
