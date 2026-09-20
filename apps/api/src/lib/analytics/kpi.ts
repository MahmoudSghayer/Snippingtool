// Platform-wide KPI overview: total/active/online users, revenue, MRR/ARR,
// trial->paid conversion, D7/D30 cohort retention, churn, extension
// installs and version distribution. Every formula here is the single
// source of truth for docs/08-analytics.md's "KPI formulas" table — read
// that doc alongside this file for the plain-English description of each
// one. Pure functions over Drizzle + (for online users) the existing WS
// presence Redis helper; no mutation, no interpolated `sql` templates.

import { extensionInstalls, payments, plans, subscriptions, userActivity, users, vArr, vMrr, type Database } from '@sl/db';
import { and, count, countDistinct, eq, gte, inArray, isNull, lt, lte, ne, sum } from 'drizzle-orm';


import { countOnline } from '../../ws/presence.js';

import { endOfDayUtc, formatDayUtc, parseDayUtc, weekBucketKey } from './dates.js';

import type { Redis } from 'ioredis';

export interface KpiRangeParams {
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Total (non-deleted) users signed up on or before `asOf` (end of that UTC
 * calendar day). */
export async function getTotalUsers(db: Database, asOf: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(users)
    .where(and(isNull(users.deletedAt), lte(users.createdAt, endOfDayUtc(asOf))));
  return row?.n ?? 0;
}

/** Distinct users with at least one `user_activity` row in the `windowDays`
 * ending at `asOf` (inclusive of `asOf`'s full day). */
export async function getActiveUsers(db: Database, asOf: string, windowDays: number): Promise<number> {
  const end = endOfDayUtc(asOf);
  const start = new Date(end.getTime() - windowDays * DAY_MS);
  const [row] = await db
    .select({ n: countDistinct(userActivity.userId) })
    .from(userActivity)
    .where(and(gte(userActivity.occurredAt, start), lt(userActivity.occurredAt, end)));
  return row?.n ?? 0;
}

/** Real-time count of WS-connected users, from the presence Redis set
 * (src/ws/presence.ts). Always "now" — has no historical dimension. */
export async function getOnlineUsers(redis: Redis): Promise<number> {
  return countOnline(redis);
}

/** Sum of succeeded payments' `amount_cents` within [from, to]. */
export async function getTotalRevenueCents(db: Database, params: KpiRangeParams): Promise<number> {
  const [row] = await db
    .select({ total: sum(payments.amountCents) })
    .from(payments)
    .where(and(eq(payments.status, 'succeeded'), gte(payments.createdAt, parseDayUtc(params.from)), lt(payments.createdAt, endOfDayUtc(params.to))));
  return Number(row?.total ?? 0);
}

/** Current MRR/ARR from `v_mrr`/`v_arr` — point-in-time snapshots, not
 * range-dependent (see docs/02-database.md for the views' own formulas). */
export async function getMrrArr(db: Database): Promise<{ mrrCents: number; arrCents: number }> {
  const [mrrRow] = await db.select().from(vMrr);
  const [arrRow] = await db.select().from(vArr);
  return { mrrCents: Number(mrrRow?.mrrCents ?? 0), arrCents: Number(arrRow?.arrCents ?? 0) };
}

export interface ConversionResult {
  cohortSize: number;
  converted: number;
  rate: number;
}

/**
 * Trial -> paid conversion for the cohort of `trial`-plan subscriptions
 * *started* (`created_at`) within [from, to].
 *
 * This schema never mutates a trial row into a paid one in place: the DB
 * constraint `subscriptions_trial_ends_only_when_trialing` forces
 * `trial_ends_at` to NULL the instant a subscription's status leaves
 * 'trialing' (see migrations/0006_subscriptions.sql, and
 * modules/subscriptions/service.ts's trial-expiry sweep, which clears it in
 * the same UPDATE), and the app's own checkout/admin-activate paths both
 * refuse to touch a row while the user still has *any* live subscription
 * (the one-live-subscription-per-user invariant) — so a paid subscription
 * is always a **separate row**, created only after the trial row has ended.
 * "Converted" therefore means: the same user has another (non-trial-plan)
 * subscription row whose `created_at` falls within 30 days of the trial's
 * end reference (`ended_at` if the trial has already run its course, else
 * `trial_ends_at` for one still in progress at query time). See
 * docs/08-analytics.md for the worked example.
 */
export async function getConversion(db: Database, params: KpiRangeParams): Promise<ConversionResult> {
  const trialPlan = await db.query.plans.findFirst({ where: eq(plans.code, 'trial') });
  if (!trialPlan) return { cohortSize: 0, converted: 0, rate: 0 };

  const cohort = await db.query.subscriptions.findMany({
    where: and(
      eq(subscriptions.planId, trialPlan.id),
      gte(subscriptions.createdAt, parseDayUtc(params.from)),
      lt(subscriptions.createdAt, endOfDayUtc(params.to)),
    ),
  });
  if (cohort.length === 0) return { cohortSize: 0, converted: 0, rate: 0 };

  const userIds = [...new Set(cohort.map((r) => r.userId))];
  const otherSubs = await db.query.subscriptions.findMany({
    where: and(inArray(subscriptions.userId, userIds), ne(subscriptions.planId, trialPlan.id)),
    columns: { userId: true, createdAt: true },
  });
  const otherCreatedAtByUser = new Map<string, number[]>();
  for (const r of otherSubs) {
    const list = otherCreatedAtByUser.get(r.userId) ?? [];
    list.push(r.createdAt.getTime());
    otherCreatedAtByUser.set(r.userId, list);
  }

  let converted = 0;
  for (const trial of cohort) {
    const referenceEnd = trial.endedAt ?? trial.trialEndsAt;
    if (!referenceEnd) continue;
    const start = referenceEnd.getTime();
    const deadline = start + 30 * DAY_MS;
    const candidates = otherCreatedAtByUser.get(trial.userId) ?? [];
    if (candidates.some((t) => t >= start && t <= deadline)) converted++;
  }

  return { cohortSize: cohort.length, converted, rate: converted / cohort.length };
}

export interface ChurnResult {
  activeAtStart: number;
  churned: number;
  rate: number;
}

/**
 * Deliberately ignores the subscription row's *current* `status` (a single
 * mutable-state column can't tell you what it was at a past instant) and
 * uses only its lifecycle timestamps, which are set once and never
 * reverted:
 *
 * - `activeAtStart`: subscriptions created before `from` whose
 *   cancellation/end (if any) had not yet happened as of `from` —
 *   `created_at <= from AND (canceled_at IS NULL OR canceled_at > from) AND
 *   (ended_at IS NULL OR ended_at > from)`. `canceled_at` is set the
 *   instant a user requests cancellation (`cancelAtPeriodEnd`), even though
 *   `status` itself often doesn't flip to 'canceled' until the period
 *   actually ends — so this row still correctly counts as "was live at
 *   `from`" for every day up to that timestamp.
 * - `churned`: subscriptions whose `canceled_at` (preferred — the
 *   user-initiated cancellation event) or, if that's unset, `ended_at`
 *   (a hard expiry with no explicit cancellation, e.g. trial lapse) falls
 *   within [from, to).
 * - `rate = churned / activeAtStart` (0 when there's no `activeAtStart`
 *   base).
 */
export async function getChurn(db: Database, params: KpiRangeParams): Promise<ChurnResult> {
  const fromInstant = parseDayUtc(params.from);
  const toEnd = endOfDayUtc(params.to);
  const rows = await db.query.subscriptions.findMany({ where: isNull(subscriptions.deletedAt) });

  const activeAtStart = rows.filter((r) => {
    if (r.createdAt.getTime() > fromInstant.getTime()) return false;
    if (r.canceledAt && r.canceledAt.getTime() <= fromInstant.getTime()) return false;
    if (r.endedAt && r.endedAt.getTime() <= fromInstant.getTime()) return false;
    return true;
  }).length;

  const churned = rows.filter((r) => {
    const endEvent = r.canceledAt ?? r.endedAt;
    if (!endEvent) return false;
    return endEvent.getTime() >= fromInstant.getTime() && endEvent.getTime() < toEnd.getTime();
  }).length;

  return { activeAtStart, churned, rate: activeAtStart > 0 ? churned / activeAtStart : 0 };
}

export interface RetentionCohort {
  cohortWeek: string;
  cohortSize: number;
  retainedD7: number;
  retainedD30: number;
  retentionD7: number;
  retentionD30: number;
}

/**
 * D7/D30 retention by signup week: for every ISO week (Monday-anchored,
 * UTC) whose users signed up within [from, to], the fraction of that
 * cohort with at least one `user_activity` row on the exact calendar day
 * `signup_day + 7` (D7) / `signup_day + 30` (D30).
 */
export async function getRetentionCohorts(db: Database, params: KpiRangeParams): Promise<RetentionCohort[]> {
  const cohortUsers = await db.query.users.findMany({
    where: and(isNull(users.deletedAt), gte(users.createdAt, parseDayUtc(params.from)), lt(users.createdAt, endOfDayUtc(params.to))),
    columns: { id: true, createdAt: true },
  });
  if (cohortUsers.length === 0) return [];

  const userIds = cohortUsers.map((u) => u.id);
  const activityRows = await db.query.userActivity.findMany({
    where: inArray(userActivity.userId, userIds),
    columns: { userId: true, occurredAt: true },
  });
  const activityByUser = new Map<string, Date[]>();
  for (const a of activityRows) {
    const list = activityByUser.get(a.userId) ?? [];
    list.push(a.occurredAt);
    activityByUser.set(a.userId, list);
  }

  const byWeek = new Map<string, Array<{ id: string; createdAt: Date }>>();
  for (const u of cohortUsers) {
    const week = weekBucketKey(formatDayUtc(u.createdAt));
    const list = byWeek.get(week) ?? [];
    list.push(u);
    byWeek.set(week, list);
  }

  const results: RetentionCohort[] = [];
  for (const [week, cohort] of [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let retainedD7 = 0;
    let retainedD30 = 0;
    for (const u of cohort) {
      const activities = activityByUser.get(u.id) ?? [];
      const d7Start = u.createdAt.getTime() + 7 * DAY_MS;
      const d30Start = u.createdAt.getTime() + 30 * DAY_MS;
      if (activities.some((t) => t.getTime() >= d7Start && t.getTime() < d7Start + DAY_MS)) retainedD7++;
      if (activities.some((t) => t.getTime() >= d30Start && t.getTime() < d30Start + DAY_MS)) retainedD30++;
    }
    results.push({
      cohortWeek: week,
      cohortSize: cohort.length,
      retainedD7,
      retainedD30,
      retentionD7: cohort.length > 0 ? retainedD7 / cohort.length : 0,
      retentionD30: cohort.length > 0 ? retainedD30 / cohort.length : 0,
    });
  }
  return results;
}

/** Live (not-uninstalled) extension installs, total and by browser. */
export async function getExtensionInstalls(db: Database): Promise<{ total: number; byBrowser: Record<string, number> }> {
  const rows = await db.query.extensionInstalls.findMany({
    where: isNull(extensionInstalls.uninstalledAt),
    columns: { browser: true },
  });
  const byBrowser: Record<string, number> = {};
  for (const r of rows) {
    const b = r.browser ?? 'unknown';
    byBrowser[b] = (byBrowser[b] ?? 0) + 1;
  }
  return { total: rows.length, byBrowser };
}

/** Version distribution across live (not-uninstalled) extension installs. */
export async function getVersionDistribution(db: Database): Promise<Record<string, number>> {
  const rows = await db.query.extensionInstalls.findMany({
    where: isNull(extensionInstalls.uninstalledAt),
    columns: { version: true },
  });
  const dist: Record<string, number> = {};
  for (const r of rows) dist[r.version] = (dist[r.version] ?? 0) + 1;
  return dist;
}

export interface KpiOverview {
  from: string;
  to: string;
  totalUsers: number;
  activeUsers7d: number;
  activeUsers30d: number;
  onlineUsers: number;
  totalRevenueCents: number;
  mrrCents: number;
  arrCents: number;
  conversion: ConversionResult;
  churn: ChurnResult;
  retention: RetentionCohort[];
  extensionInstalls: { total: number; byBrowser: Record<string, number> };
  versionDistribution: Record<string, number>;
}

/** Assembles the full admin overview KPI screen's data in one call — every
 * field documented individually above and in docs/08-analytics.md. */
export async function getKpiOverview(db: Database, redis: Redis, params: KpiRangeParams): Promise<KpiOverview> {
  const [totalUsers, activeUsers7d, activeUsers30d, onlineUsers, totalRevenueCents, mrrArr, conversion, churn, retention, installs, versionDistribution] =
    await Promise.all([
      getTotalUsers(db, params.to),
      getActiveUsers(db, params.to, 7),
      getActiveUsers(db, params.to, 30),
      getOnlineUsers(redis),
      getTotalRevenueCents(db, params),
      getMrrArr(db),
      getConversion(db, params),
      getChurn(db, params),
      getRetentionCohorts(db, params),
      getExtensionInstalls(db),
      getVersionDistribution(db),
    ]);

  return {
    from: params.from,
    to: params.to,
    totalUsers,
    activeUsers7d,
    activeUsers30d,
    onlineUsers,
    totalRevenueCents,
    mrrCents: mrrArr.mrrCents,
    arrCents: mrrArr.arrCents,
    conversion,
    churn,
    retention,
    extensionInstalls: installs,
    versionDistribution,
  };
}
