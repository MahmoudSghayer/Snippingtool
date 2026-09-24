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
//   - the `profits.rollup` job sweeps today for every active user as a
//     self-healing backstop.
//
// Day attribution (also documented in docs/08-analytics.md): coins spent
// and snipes count on the day the purchase/attempt happened; coins earned,
// net profit and closed trades count on the day the sale happened.

import { profits, snipingActivity, trades, type Database } from '@sl/db';
import { and, eq, gte, isNull, lt } from 'drizzle-orm';

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

/** Recomputes and upserts the `profits` row for one user on one UTC day.
 * Returns the totals written. A day with no activity at all still gets a
 * zero row if one already existed (so a deleted/corrected trade zeroes it
 * out rather than leaving stale numbers behind). */
export async function rollupProfitsForUserDay(
  db: Database,
  userId: string,
  day: string,
): Promise<ProfitDayTotals> {
  const { start, end } = dayBounds(day);

  const [sold, bought, snipes] = await Promise.all([
    db.query.trades.findMany({
      where: and(
        eq(trades.userId, userId),
        isNull(trades.deletedAt),
        gte(trades.soldAt, start),
        lt(trades.soldAt, end),
      ),
    }),
    db.query.trades.findMany({
      where: and(
        eq(trades.userId, userId),
        isNull(trades.deletedAt),
        gte(trades.boughtAt, start),
        lt(trades.boughtAt, end),
      ),
    }),
    db.query.snipingActivity.findMany({
      where: and(
        eq(snipingActivity.userId, userId),
        gte(snipingActivity.occurredAt, start),
        lt(snipingActivity.occurredAt, end),
      ),
    }),
  ]);

  const totals: ProfitDayTotals = {
    coinsSpent: bought.reduce((sum, t) => sum + (t.buyPrice ?? 0), 0),
    coinsEarned: sold.reduce((sum, t) => sum + (t.sellPrice ?? 0), 0),
    netProfit: sold.reduce((sum, t) => sum + (t.netProfit ?? 0), 0),
    snipes: snipes.length,
    successes: snipes.filter((s) => s.outcome === 'success').length,
    tradesClosed: sold.length,
  };

  const hasActivity = sold.length + bought.length + snipes.length > 0;

  // Two writes for the same user can roll the same day up at once (a trades
  // batch and a sniping ingest, or a request racing the hourly job), so the
  // insert must not assume it is first. A day with no activity only ever
  // updates an existing row (zeroing it) and never creates an empty one.
  if (hasActivity) {
    await db
      .insert(profits)
      .values({ id: newId(), userId, day, ...totals })
      .onConflictDoUpdate({ target: [profits.userId, profits.day], set: totals });
  } else {
    await db
      .update(profits)
      .set(totals)
      .where(and(eq(profits.userId, userId), eq(profits.day, day)));
  }
  return totals;
}

/** Recomputes the `profits` row for every `(user, day)` pair in `keys`.
 * Deduplicates, so a batch touching the same day many times rolls it up
 * once. */
export async function rollupProfitsForUserDays(
  db: Database,
  keys: Iterable<{ userId: string; day: string }>,
): Promise<number> {
  const seen = new Set<string>();
  for (const { userId, day } of keys) {
    const k = `${userId}|${day}`;
    if (seen.has(k)) continue;
    seen.add(k);
    await rollupProfitsForUserDay(db, userId, day);
  }
  return seen.size;
}

/** Every user with a purchase, sale or snipe attempt on `day`, rolled up.
 * Used by the hourly `profits.rollup` job for today. */
export async function rollupProfitsForDay(db: Database, day: string): Promise<number> {
  const { start, end } = dayBounds(day);
  const [sold, bought, snipes] = await Promise.all([
    db
      .select({ userId: trades.userId })
      .from(trades)
      .where(and(isNull(trades.deletedAt), gte(trades.soldAt, start), lt(trades.soldAt, end))),
    db
      .select({ userId: trades.userId })
      .from(trades)
      .where(and(isNull(trades.deletedAt), gte(trades.boughtAt, start), lt(trades.boughtAt, end))),
    db
      .select({ userId: snipingActivity.userId })
      .from(snipingActivity)
      .where(and(gte(snipingActivity.occurredAt, start), lt(snipingActivity.occurredAt, end))),
  ]);
  const userIds = new Set([...sold, ...bought, ...snipes].map((r) => r.userId));
  return rollupProfitsForUserDays(
    db,
    [...userIds].map((userId) => ({ userId, day })),
  );
}
