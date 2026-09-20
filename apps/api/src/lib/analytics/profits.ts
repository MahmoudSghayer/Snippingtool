// Profit analytics: platform-wide and per-user series over any date range
// at day/week/month/lifetime granularity, leaderboards, lifetime totals,
// average profit per active trader, total coins traded and snipe success
// rate — all derived from the `profits` daily-rollup table (maintained by
// the `profits.rollup` job) plus `v_user_lifetime_profit` for all-time
// per-user totals. Every function is a pure query: no mutation, no
// side-effects, parameterised Drizzle only.

import { profits, users, vUserLifetimeProfit, type Database } from '@sl/db';
import { and, asc, desc, eq, gte, lte, sum } from 'drizzle-orm';

import { aggregateIntoBuckets, type Granularity } from './dates.js';

export interface ProfitRangeParams {
  from: string;
  to: string;
  granularity: Granularity;
}

interface ProfitAcc {
  netProfit: number;
  coinsSpent: number;
  coinsEarned: number;
  snipes: number;
  successes: number;
  tradesClosed: number;
  traders: Set<string>;
}

function zeroAcc(): ProfitAcc {
  return { netProfit: 0, coinsSpent: 0, coinsEarned: 0, snipes: 0, successes: 0, tradesClosed: 0, traders: new Set() };
}

export interface ProfitSeriesPoint {
  bucket: string;
  netProfit: number;
  coinsSpent: number;
  coinsEarned: number;
  coinsTraded: number;
  snipes: number;
  successes: number;
  tradesClosed: number;
  activeTraders: number;
  snipeSuccessRate: number;
}

function toPoint(bucket: string, acc: ProfitAcc): ProfitSeriesPoint {
  return {
    bucket,
    netProfit: acc.netProfit,
    coinsSpent: acc.coinsSpent,
    coinsEarned: acc.coinsEarned,
    coinsTraded: acc.coinsSpent + acc.coinsEarned,
    snipes: acc.snipes,
    successes: acc.successes,
    tradesClosed: acc.tradesClosed,
    activeTraders: acc.traders.size,
    snipeSuccessRate: acc.snipes > 0 ? acc.successes / acc.snipes : 0,
  };
}

interface ProfitDayRow {
  userId: string;
  day: string;
  netProfit: number;
  coinsSpent: number;
  coinsEarned: number;
  snipes: number;
  successes: number;
  tradesClosed: number;
}

function addRow(acc: ProfitAcc, row: ProfitDayRow): ProfitAcc {
  acc.netProfit += row.netProfit;
  acc.coinsSpent += row.coinsSpent;
  acc.coinsEarned += row.coinsEarned;
  acc.snipes += row.snipes;
  acc.successes += row.successes;
  acc.tradesClosed += row.tradesClosed;
  acc.traders.add(row.userId);
  return acc;
}

/** Platform-wide profit series across every user, bucketed and zero-filled. */
export async function getPlatformProfitSeries(db: Database, params: ProfitRangeParams): Promise<ProfitSeriesPoint[]> {
  const rows = await db.query.profits.findMany({
    where: and(gte(profits.day, params.from), lte(profits.day, params.to)),
  });
  const dayRows: ProfitDayRow[] = rows.map((r) => ({
    userId: r.userId,
    day: r.day,
    netProfit: r.netProfit,
    coinsSpent: r.coinsSpent,
    coinsEarned: r.coinsEarned,
    snipes: r.snipes,
    successes: r.successes,
    tradesClosed: r.tradesClosed,
  }));
  return aggregateIntoBuckets(dayRows, (r) => r.day, params.from, params.to, params.granularity, zeroAcc, addRow).map((b) =>
    toPoint(b.bucket, b.value),
  );
}

/** Per-user profit series (used by the user-facing /analytics/me/profits
 * route, and by admin single-user drilldowns). */
export async function getUserProfitSeries(db: Database, userId: string, params: ProfitRangeParams): Promise<ProfitSeriesPoint[]> {
  const rows = await db.query.profits.findMany({
    where: and(eq(profits.userId, userId), gte(profits.day, params.from), lte(profits.day, params.to)),
  });
  const dayRows: ProfitDayRow[] = rows.map((r) => ({
    userId: r.userId,
    day: r.day,
    netProfit: r.netProfit,
    coinsSpent: r.coinsSpent,
    coinsEarned: r.coinsEarned,
    snipes: r.snipes,
    successes: r.successes,
    tradesClosed: r.tradesClosed,
  }));
  return aggregateIntoBuckets(dayRows, (r) => r.day, params.from, params.to, params.granularity, zeroAcc, addRow).map((b) =>
    toPoint(b.bucket, b.value),
  );
}

export interface LifetimeProfit {
  netProfit: number;
  coinsSpent: number;
  coinsEarned: number;
  snipes: number;
  successes: number;
  tradesClosed: number;
  firstActiveDay: string | null;
  lastActiveDay: string | null;
}

const EMPTY_LIFETIME: LifetimeProfit = {
  netProfit: 0,
  coinsSpent: 0,
  coinsEarned: 0,
  snipes: 0,
  successes: 0,
  tradesClosed: 0,
  firstActiveDay: null,
  lastActiveDay: null,
};

/** All-time per-user totals, from `v_user_lifetime_profit`. */
export async function getUserLifetimeProfit(db: Database, userId: string): Promise<LifetimeProfit> {
  const [row] = await db.select().from(vUserLifetimeProfit).where(eq(vUserLifetimeProfit.userId, userId));
  if (!row) return EMPTY_LIFETIME;
  return {
    netProfit: row.lifetimeNetProfit ?? 0,
    coinsSpent: row.lifetimeCoinsSpent ?? 0,
    coinsEarned: row.lifetimeCoinsEarned ?? 0,
    snipes: row.lifetimeSnipes ?? 0,
    successes: row.lifetimeSuccesses ?? 0,
    tradesClosed: row.lifetimeTradesClosed ?? 0,
    firstActiveDay: row.firstActiveDay,
    lastActiveDay: row.lastActiveDay,
  };
}

/** Total net profit + coins traded across the whole platform for [from,to],
 * plus average net profit per user who was active (had a `profits` row) in
 * that range. */
export async function getPlatformLifetimeSummary(
  db: Database,
  params: { from: string; to: string },
): Promise<{ netProfit: number; coinsTraded: number; avgProfitPerActiveTrader: number }> {
  const rows = await db.query.profits.findMany({
    where: and(gte(profits.day, params.from), lte(profits.day, params.to)),
  });
  let netProfit = 0;
  let coinsTraded = 0;
  const traders = new Set<string>();
  for (const r of rows) {
    netProfit += r.netProfit;
    coinsTraded += r.coinsSpent + r.coinsEarned;
    traders.add(r.userId);
  }
  return { netProfit, coinsTraded, avgProfitPerActiveTrader: traders.size > 0 ? netProfit / traders.size : 0 };
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  email: string;
  netProfit: number;
  coinsTraded: number;
  snipes: number;
  successes: number;
  tradesClosed: number;
}

export interface LeaderboardParams {
  from: string;
  to: string;
  limit: number;
  order: 'top' | 'least';
}

/** Top N (or least N) users by net profit summed over [from, to]. Ties are
 * broken by `users.id` ascending for a stable, deterministic order. Uses
 * Drizzle's `sum()` aggregate helper (never a raw interpolated `sql`
 * template — see the repo eslint preset's `no-sql-template-interpolation`
 * rule) so ordering happens in Postgres, not by loading every row. */
export async function getProfitLeaderboard(db: Database, params: LeaderboardParams): Promise<LeaderboardEntry[]> {
  const netProfitSum = sum(profits.netProfit);

  const rows = await db
    .select({
      userId: profits.userId,
      email: users.email,
      netProfit: netProfitSum,
      coinsSpent: sum(profits.coinsSpent),
      coinsEarned: sum(profits.coinsEarned),
      snipes: sum(profits.snipes),
      successes: sum(profits.successes),
      tradesClosed: sum(profits.tradesClosed),
    })
    .from(profits)
    .innerJoin(users, eq(users.id, profits.userId))
    .where(and(gte(profits.day, params.from), lte(profits.day, params.to)))
    .groupBy(profits.userId, users.email)
    .orderBy(params.order === 'top' ? desc(netProfitSum) : asc(netProfitSum), asc(profits.userId))
    .limit(params.limit);

  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.userId,
    email: r.email,
    netProfit: Number(r.netProfit ?? 0),
    coinsTraded: Number(r.coinsSpent ?? 0) + Number(r.coinsEarned ?? 0),
    snipes: Number(r.snipes ?? 0),
    successes: Number(r.successes ?? 0),
    tradesClosed: Number(r.tradesClosed ?? 0),
  }));
}
