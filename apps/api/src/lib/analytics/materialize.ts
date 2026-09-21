// Materialisation: computes every daily metric for one UTC calendar day and
// upserts it into `analytics_daily` (unique on (day, metric, dimension), so
// re-running for the same day is idempotent — the row's `value` is simply
// overwritten with the freshly computed number). Consumed by
// jobs/analytics.daily.job.ts (previous day, nightly) and
// jobs/analytics.hourly.job.ts (today, hourly — a "partial day" row that
// converges as the day progresses, same self-healing idempotent-upsert
// pattern as profits.rollup.job.ts) and by src/lib/analytics/backfill.ts.
//
// Known limitation: `mrr_cents`/`arr_cents`/`plan_mix`/`past_due_count` are
// **point-in-time snapshots taken when the job runs**, not day-accurate
// historical reconstructions (subscriptions is a single mutable-state
// table with no history log — see docs/08-analytics.md). Backfilling a
// past day recomputes these from *today's* subscription state, which is a
// deliberate, documented trade-off, not a bug: re-running
// `analytics.daily`/`analytics.hourly` for "yesterday" every night keeps
// them fresh going forward; only a true historical backfill run once,
// long after the fact, would show today's snapshot under a past day's row.

import { analyticsDaily, users, type Database } from '@sl/db';
import { and, count, gte, isNull, lt, sql } from 'drizzle-orm';

import { newId } from '../ids.js';

import { getActivitySeries } from './activity.js';
import { endOfDayUtc, parseDayUtc } from './dates.js';
import { getFeatureUsage } from './features.js';
import { getActiveUsers, getExtensionInstalls, getMrrArr, getTotalRevenueCents } from './kpi.js';
import { getPlatformProfitSeries } from './profits.js';
import { getPastDueCount, getPlanMix, getSubscriptionSeries } from './subscriptions.js';

export interface DailyMetricRow {
  day: string;
  metric: string;
  dimension: string;
  value: number;
}

async function getNewUsersCount(db: Database, day: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        gte(users.createdAt, parseDayUtc(day)),
        lt(users.createdAt, endOfDayUtc(day)),
      ),
    );
  return row?.n ?? 0;
}

/** Computes every materialised metric for one UTC day. Pure (no writes). */
export async function computeDailyMetrics(db: Database, day: string): Promise<DailyMetricRow[]> {
  const dayRange = { from: day, to: day, granularity: 'day' as const };

  const [
    newUsers,
    activeUsers7d,
    activeUsers30d,
    revenueCents,
    mrrArr,
    profitPoints,
    activityPoints,
    subscriptionPoints,
    installs,
    planMix,
    pastDueCount,
    featureUsage,
  ] = await Promise.all([
    getNewUsersCount(db, day),
    getActiveUsers(db, day, 7),
    getActiveUsers(db, day, 30),
    getTotalRevenueCents(db, { from: day, to: day }),
    getMrrArr(db),
    getPlatformProfitSeries(db, dayRange),
    getActivitySeries(db, dayRange),
    getSubscriptionSeries(db, dayRange),
    getExtensionInstalls(db),
    getPlanMix(db),
    getPastDueCount(db),
    getFeatureUsage(db, { from: day, to: day }),
  ]);

  const profitPoint = profitPoints[0]!;
  const activityPoint = activityPoints[0]!;
  const subscriptionPoint = subscriptionPoints[0]!;

  const rows: DailyMetricRow[] = [];
  const put = (metric: string, value: number, dimension = '') =>
    rows.push({ day, metric, dimension, value });

  put('new_users', newUsers);
  put('active_users_7d', activeUsers7d);
  put('active_users_30d', activeUsers30d);
  put('revenue_cents', revenueCents);
  put('mrr_cents', mrrArr.mrrCents);
  put('arr_cents', mrrArr.arrCents);

  put('net_profit_cents', profitPoint.netProfit);
  put('coins_spent', profitPoint.coinsSpent);
  put('coins_earned', profitPoint.coinsEarned);
  put('coins_traded', profitPoint.coinsTraded);
  put('snipes', profitPoint.snipes);
  put('snipe_successes', profitPoint.successes);
  put('trades_closed', profitPoint.tradesClosed);

  put('logins', activityPoint.logins);
  put('searches', activityPoint.searches);
  put('filter_changes', activityPoint.filterChanges);
  put('snipe_attempts', activityPoint.snipeAttempts);
  put('errors', activityPoint.errors);
  put('active_devices', activityPoint.activeDevices);
  put('active_ips', activityPoint.activeIps);

  put('new_subscriptions', subscriptionPoint.newSubscriptions);
  put('canceled_subscriptions', subscriptionPoint.canceledSubscriptions);
  put('trial_starts', subscriptionPoint.trialStarts);
  put('trial_conversions', subscriptionPoint.trialConversions);
  put('coupon_redemptions', subscriptionPoint.couponRedemptions);

  put('extension_installs_total', installs.total);
  for (const [browser, n] of Object.entries(installs.byBrowser))
    put('extension_installs', n, browser);
  for (const [code, n] of Object.entries(planMix)) put('plan_mix', n, code);
  put('past_due_count', pastDueCount);
  for (const [feature, n] of Object.entries(featureUsage)) put('feature_usage', n, feature);

  return rows;
}

/** Upserts every row: insert, or update `value` on a (day, metric,
 * dimension) conflict. Idempotent — running this twice for the same day
 * with the same underlying data produces the same final rows. */
export async function upsertAnalyticsDaily(db: Database, rows: DailyMetricRow[]): Promise<void> {
  for (const row of rows) {
    await db
      .insert(analyticsDaily)
      .values({
        id: newId(),
        day: row.day,
        metric: row.metric,
        dimension: row.dimension,
        value: row.value.toString(),
      })
      .onConflictDoUpdate({
        target: [analyticsDaily.day, analyticsDaily.metric, analyticsDaily.dimension],
        set: { value: row.value.toString() },
      });
  }
}

/** `SELECT refresh_mv_kpi_daily()` — a `REFRESH MATERIALIZED VIEW
 * CONCURRENTLY` under the hood (migrations/0023_analytics.sql), safe to
 * call while readers are querying `mv_kpi_daily`. */
export async function refreshMvKpiDaily(db: Database): Promise<void> {
  await db.execute(sql`select refresh_mv_kpi_daily()`);
}

/** Computes and upserts one day's metrics in one call — the shared body
 * behind both the nightly and hourly jobs and the backfill script. */
export async function materializeDay(db: Database, day: string): Promise<number> {
  const rows = await computeDailyMetrics(db, day);
  await upsertAnalyticsDaily(db, rows);
  return rows.length;
}
