// Subscription metrics: plan mix, new/canceled subscriptions per period,
// trial starts, trial conversions, past_due snapshot count, coupon
// redemptions per period.

import { couponRedemptions, plans, subscriptions, type Database } from '@sl/db';
import { and, count, eq, gte, inArray, isNull, lt } from 'drizzle-orm';

import { bucketKeyFor, endOfDayUtc, formatDayUtc, listBuckets, parseDayUtc, type Granularity } from './dates.js';

const LIVE_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'lifetime'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubscriptionRangeParams {
  from: string;
  to: string;
  granularity: Granularity;
}

export interface SubscriptionPoint {
  bucket: string;
  newSubscriptions: number;
  canceledSubscriptions: number;
  trialStarts: number;
  trialConversions: number;
  couponRedemptions: number;
}

/**
 * Per-bucket subscription lifecycle counts. `trialConversions` uses the
 * same conversion test as `getConversion` in kpi.ts (billing actually
 * started, within 30 days of `trial_ends_at`) but is bucketed by *when
 * billing started* (`current_period_start`) rather than by cohort/trial
 * start, so it lines up with "conversions that happened in this bucket".
 */
export async function getSubscriptionSeries(db: Database, params: SubscriptionRangeParams): Promise<SubscriptionPoint[]> {
  const start = parseDayUtc(params.from);
  const end = endOfDayUtc(params.to);

  const [subRows, couponRows] = await Promise.all([
    db.query.subscriptions.findMany({
      where: isNull(subscriptions.deletedAt),
      columns: { id: true, createdAt: true, canceledAt: true, trialEndsAt: true, currentPeriodStart: true, status: true },
    }),
    db.query.couponRedemptions.findMany({
      where: and(gte(couponRedemptions.redeemedAt, start), lt(couponRedemptions.redeemedAt, end)),
      columns: { redeemedAt: true },
    }),
  ]);

  const buckets = listBuckets(params.from, params.to, params.granularity);
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const points: SubscriptionPoint[] = buckets.map((bucket) => ({
    bucket,
    newSubscriptions: 0,
    canceledSubscriptions: 0,
    trialStarts: 0,
    trialConversions: 0,
    couponRedemptions: 0,
  }));

  const bucketOf = (d: Date): number | undefined => {
    const key = params.granularity === 'lifetime' ? 'lifetime' : bucketKeyFor(formatDayUtc(d), params.granularity);
    return idx.get(key);
  };
  const inRange = (d: Date) => d.getTime() >= start.getTime() && d.getTime() < end.getTime();

  for (const s of subRows) {
    if (inRange(s.createdAt)) {
      const i = bucketOf(s.createdAt);
      if (i !== undefined) {
        points[i]!.newSubscriptions++;
        if (s.trialEndsAt) points[i]!.trialStarts++;
      }
    }
    if (s.canceledAt && inRange(s.canceledAt)) {
      const i = bucketOf(s.canceledAt);
      if (i !== undefined) points[i]!.canceledSubscriptions++;
    }
    if (
      s.trialEndsAt &&
      s.currentPeriodStart &&
      s.status !== 'trialing' &&
      s.status !== 'canceled' &&
      s.status !== 'expired' &&
      inRange(s.currentPeriodStart) &&
      s.currentPeriodStart.getTime() <= s.trialEndsAt.getTime() + 30 * DAY_MS
    ) {
      const i = bucketOf(s.currentPeriodStart);
      if (i !== undefined) points[i]!.trialConversions++;
    }
  }

  for (const c of couponRows) {
    const i = bucketOf(c.redeemedAt);
    if (i !== undefined) points[i]!.couponRedemptions++;
  }

  return points;
}

/** Current distribution of live subscriptions by plan code (snapshot,
 * "now" — not range-dependent). */
export async function getPlanMix(db: Database): Promise<Record<string, number>> {
  const rows = await db
    .select({ code: plans.code })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(and(isNull(subscriptions.deletedAt), inArray(subscriptions.status, [...LIVE_STATUSES])));
  const mix: Record<string, number> = {};
  for (const r of rows) mix[r.code] = (mix[r.code] ?? 0) + 1;
  return mix;
}

/** Current count of subscriptions in `past_due` status (snapshot). */
export async function getPastDueCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(and(isNull(subscriptions.deletedAt), eq(subscriptions.status, 'past_due')));
  return row?.n ?? 0;
}
