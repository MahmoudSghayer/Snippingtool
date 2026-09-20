// Subscription state machine, trial protection, and the primitives every
// other module in this agent's ownership (admin-subscriptions, payments'
// webhook handlers, the subscriptions.expire/abuse.scan jobs) builds on.
// See docs/05-subscriptions.md §2 (state machine) and §5 (trial protection)
// for the full design this file implements.

import { devices, ipActivity, notifications, plans, subscriptions, users, type Database } from '@sl/db';
import { normaliseEmailForAbuseCheck, TRIAL_LENGTH_DAYS, type SubscriptionStatus } from '@sl/shared';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm';

import { AppErrors } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { publishToUser } from '../../ws/publish.js';
import { createFlag } from '../flags/service.js';
import { findActiveForSubscription, issueForSubscription, revoke as revokeLicense } from '../licenses/service.js';
import { toPlanDto } from '../plans/index.js';

import type { Redis } from 'ioredis';

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;

/** "Live" = counts against the one-live-subscription-per-user partial
 * unique index (`02-database.md` §6.3) and is what `/subscriptions/me`,
 * trial/checkout/admin-activate all treat as "this user already has a
 * subscription". */
export const LIVE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'lifetime'] as const;

export function isLiveStatus(status: string): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export async function getPlanByCode(db: Database, code: string): Promise<PlanRow | null> {
  const row = await db.query.plans.findFirst({ where: and(eq(plans.code, code), isNull(plans.deletedAt)) });
  return row ?? null;
}

export async function getPlanById(db: Database, planId: string): Promise<PlanRow | null> {
  const row = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
  return row ?? null;
}

export async function findSubscriptionById(db: Database, subscriptionId: string): Promise<SubscriptionRow | null> {
  const row = await db.query.subscriptions.findFirst({ where: eq(subscriptions.id, subscriptionId) });
  return row && !row.deletedAt ? row : null;
}

/** The user's current *live* subscription, or null. A user may have many
 * historical (canceled/expired) rows — this only ever returns a live one. */
export async function getLiveSubscriptionForUser(db: Database, userId: string): Promise<SubscriptionRow | null> {
  const row = await db.query.subscriptions.findFirst({
    where: and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt)),
    orderBy: [desc(subscriptions.createdAt)],
  });
  return row && isLiveStatus(row.status) ? row : null;
}

/** Most recent subscription row regardless of status — used by `resume`,
 * which specifically operates on a `canceled` (non-live) row. */
export async function getLatestSubscriptionForUser(db: Database, userId: string): Promise<SubscriptionRow | null> {
  const row = await db.query.subscriptions.findFirst({
    where: and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt)),
    orderBy: [desc(subscriptions.createdAt)],
  });
  return row ?? null;
}

export function toSubscriptionDto(row: SubscriptionRow, plan: PlanRow) {
  return {
    id: row.id,
    plan: toPlanDto(plan),
    status: row.status,
    currentPeriodStart: row.currentPeriodStart ? row.currentPeriodStart.toISOString() : null,
    currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
    trialEndsAt: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    autoRenew: row.autoRenew,
  };
}

async function publishSubscriptionChanged(redis: Redis, row: SubscriptionRow, plan: PlanRow): Promise<void> {
  await publishToUser(redis, row.userId, { type: 'subscription.changed', subscription: toSubscriptionDto(row, plan) });
}

// ---------------------------------------------------------------------------
// Trial protection (docs/05-subscriptions.md §5)
// ---------------------------------------------------------------------------

/** First three octets (IPv4) / first three hextets (IPv6) — a coarse
 * "same network" heuristic, not a full CIDR parse. */
export function ipToAbusePrefix(ip: string): string {
  if (ip.includes(':')) {
    const parts = ip.split(':').filter((p) => p.length > 0);
    return parts.slice(0, 3).join(':');
  }
  const parts = ip.split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : ip;
}

export interface TrialAbuseMatch {
  detector: 'email' | 'device' | 'ip';
  matchedUserIds: string[];
}

const TRIAL_ABUSE_WINDOW_MS = 30 * DAY_MS;

/** Runs all three checks (docs §5) and returns every one that matched — the
 * caller decides what to do with them (deny + flag). Never throws for "no
 * match"; an empty array means clean. */
export async function checkTrialAbuse(
  db: Database,
  input: { normalisedEmail: string; fingerprintHash: string | null; ipPrefix: string | null; excludeUserId: string },
): Promise<TrialAbuseMatch[]> {
  const matches: TrialAbuseMatch[] = [];

  // Every user who has ever had a trial (trial_ends_at set at some point),
  // regardless of that subscription's current status — this is the
  // unbounded-lookback set checks 1/2/3 all filter against.
  const trialHistory = await db
    .select({ userId: subscriptions.userId, email: users.email })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .where(and(isNotNull(subscriptions.trialEndsAt), ne(subscriptions.userId, input.excludeUserId)));

  const trialUserIds = new Set(trialHistory.map((r) => r.userId));

  const emailMatches = [
    ...new Set(
      trialHistory.filter((r) => normaliseEmailForAbuseCheck(r.email) === input.normalisedEmail).map((r) => r.userId),
    ),
  ];
  if (emailMatches.length > 0) matches.push({ detector: 'email', matchedUserIds: emailMatches });

  const windowStart = new Date(Date.now() - TRIAL_ABUSE_WINDOW_MS);

  if (input.fingerprintHash) {
    const deviceRows = await db.query.devices.findMany({
      where: and(
        eq(devices.fingerprintHash, input.fingerprintHash),
        gte(devices.firstSeenAt, windowStart),
        isNull(devices.deletedAt),
      ),
    });
    const deviceMatches = [
      ...new Set(deviceRows.map((d) => d.userId).filter((id) => id !== input.excludeUserId && trialUserIds.has(id))),
    ];
    if (deviceMatches.length > 0) matches.push({ detector: 'device', matchedUserIds: deviceMatches });
  }

  if (input.ipPrefix) {
    const ipRows = await db.query.ipActivity.findMany({ where: gte(ipActivity.lastSeen, windowStart) });
    const ipMatches = [
      ...new Set(
        ipRows
          .filter(
            (r): r is typeof r & { userId: string } =>
              r.userId !== null &&
              r.userId !== input.excludeUserId &&
              trialUserIds.has(r.userId) &&
              ipToAbusePrefix(r.ip) === input.ipPrefix,
          )
          .map((r) => r.userId),
      ),
    ];
    if (ipMatches.length > 0) matches.push({ detector: 'ip', matchedUserIds: ipMatches });
  }

  return matches;
}

export function trialAbuseSeverity(matchCount: number): 'low' | 'medium' | 'critical' {
  if (matchCount >= 3) return 'critical';
  if (matchCount === 2) return 'medium';
  return 'low';
}

/** Upserts the (ip, userId) counter row `checkTrialAbuse`'s IP check reads
 * back later — written on every trial attempt, successful or not
 * (docs §5, check 3's data source). */
export async function recordTrialIpActivity(db: Database, ip: string, userId: string): Promise<void> {
  const existing = await db.query.ipActivity.findFirst({
    where: and(eq(ipActivity.ip, ip), eq(ipActivity.userId, userId)),
  });
  if (existing) {
    await db
      .update(ipActivity)
      .set({ lastSeen: new Date(), requestCount: existing.requestCount + 1 })
      .where(eq(ipActivity.id, existing.id));
  } else {
    await db.insert(ipActivity).values({ id: newId(), ip, userId, firstSeen: new Date(), lastSeen: new Date(), requestCount: 1 });
  }
}

export interface StartTrialInput {
  userId: string;
  email: string;
  fingerprintHash: string | null;
  ip: string | null;
}

export type StartTrialResult =
  | { blocked: true; matches: TrialAbuseMatch[] }
  | {
      blocked: false;
      subscription: SubscriptionRow;
      plan: PlanRow;
      license: { key: string; keyPrefix: string; maxDevices: number; expiresAt: Date | null };
    };

export async function startTrial(db: Database, redis: Redis, input: StartTrialInput): Promise<StartTrialResult> {
  const existingLive = await getLiveSubscriptionForUser(db, input.userId);
  if (existingLive) throw AppErrors.conflict('You already have an active subscription.');

  const normalisedEmail = normaliseEmailForAbuseCheck(input.email);
  const ipPrefix = input.ip ? ipToAbusePrefix(input.ip) : null;

  const matches = await checkTrialAbuse(db, {
    normalisedEmail,
    fingerprintHash: input.fingerprintHash,
    ipPrefix,
    excludeUserId: input.userId,
  });

  if (input.ip) await recordTrialIpActivity(db, input.ip, input.userId);

  if (matches.length > 0) {
    await createFlag(db, {
      userId: input.userId,
      kind: 'trial_abuse',
      severity: trialAbuseSeverity(matches.length),
      evidence: {
        detectors: matches.map((m) => m.detector),
        matches: matches.map((m) => ({ detector: m.detector, matchedUserIds: m.matchedUserIds })),
        normalisedEmail,
        ipPrefix,
      },
    });
    return { blocked: true, matches };
  }

  const plan = await getPlanByCode(db, 'trial');
  if (!plan) throw AppErrors.internal('Trial plan is not configured.');

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_LENGTH_DAYS * DAY_MS);

  const [subRow] = await db
    .insert(subscriptions)
    .values({
      id: newId(),
      userId: input.userId,
      planId: plan.id,
      status: 'trialing',
      currentPeriodStart: now,
      currentPeriodEnd: null,
      trialEndsAt,
      cancelAtPeriodEnd: false,
      autoRenew: false,
      source: 'manual',
    })
    .returning();

  const { row: licenseRow, fullKey } = await issueForSubscription(db, {
    subscriptionId: subRow!.id,
    userId: input.userId,
    maxDevices: plan.deviceLimit,
    expiresAt: trialEndsAt,
  });

  await db.insert(notifications).values({
    id: newId(),
    userId: input.userId,
    type: 'subscription.trial_started',
    title: 'Your 7-day trial has started',
    body: `You have full access until ${trialEndsAt.toISOString()}.`,
    data: { subscriptionId: subRow!.id },
    deliveredVia: 'in_app',
  });

  await publishSubscriptionChanged(redis, subRow!, plan);

  return {
    blocked: false,
    subscription: subRow!,
    plan,
    license: { key: fullKey, keyPrefix: licenseRow.keyPrefix, maxDevices: licenseRow.maxDevices, expiresAt: licenseRow.expiresAt },
  };
}

// ---------------------------------------------------------------------------
// User-facing cancel / resume
// ---------------------------------------------------------------------------

export async function cancelAtPeriodEnd(db: Database, redis: Redis, userId: string): Promise<SubscriptionRow> {
  const sub = await getLiveSubscriptionForUser(db, userId);
  if (!sub) throw AppErrors.notFound('subscription');
  if (sub.status === 'lifetime') throw AppErrors.conflict('A lifetime subscription cannot be canceled.');
  if (sub.cancelAtPeriodEnd) throw AppErrors.conflict('Subscription is already set to cancel at period end.');

  const [row] = await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true, canceledAt: new Date() })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  const plan = await getPlanById(db, row!.planId);
  if (plan) await publishSubscriptionChanged(redis, row!, plan);
  return row!;
}

export async function resumeCanceled(db: Database, redis: Redis, userId: string): Promise<SubscriptionRow> {
  const sub = await getLatestSubscriptionForUser(db, userId);
  const now = Date.now();
  const stillWithinPeriod = Boolean(sub?.currentPeriodEnd && sub.currentPeriodEnd.getTime() > now);
  if (!sub || !sub.cancelAtPeriodEnd || !stillWithinPeriod || !isLiveStatus(sub.status)) {
    throw AppErrors.conflict('Subscription cannot be resumed (not set to cancel, already ended, or not live).');
  }

  const [row] = await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: false, canceledAt: null })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  const plan = await getPlanById(db, row!.planId);
  if (plan) await publishSubscriptionChanged(redis, row!, plan);
  return row!;
}

// ---------------------------------------------------------------------------
// Admin / system mutations (also used by the payments webhook + jobs)
// ---------------------------------------------------------------------------

export async function activateManual(
  db: Database,
  redis: Redis,
  input: { userId: string; planCode: string; periodDays: number; grantedByAdminId: string | null; source?: 'manual' | 'coupon' },
): Promise<{ subscription: SubscriptionRow; plan: PlanRow; license: { row: Awaited<ReturnType<typeof issueForSubscription>>['row']; fullKey: string } }> {
  const existingLive = await getLiveSubscriptionForUser(db, input.userId);
  if (existingLive) throw AppErrors.conflict('User already has a live subscription.');
  const plan = await getPlanByCode(db, input.planCode);
  if (!plan) throw AppErrors.notFound('plan');

  const now = new Date();
  const periodEnd = new Date(now.getTime() + input.periodDays * DAY_MS);

  const [row] = await db
    .insert(subscriptions)
    .values({
      id: newId(),
      userId: input.userId,
      planId: plan.id,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      autoRenew: false,
      source: input.source ?? 'manual',
      grantedByAdminId: input.grantedByAdminId,
    })
    .returning();

  const license = await issueForSubscription(db, {
    subscriptionId: row!.id,
    userId: input.userId,
    maxDevices: plan.deviceLimit,
    expiresAt: periodEnd,
  });

  await publishSubscriptionChanged(redis, row!, plan);
  return { subscription: row!, plan, license };
}

export async function grantLifetime(
  db: Database,
  redis: Redis,
  input: { userId: string; planCode: string; grantedByAdminId: string | null; source?: 'manual' | 'coupon' },
): Promise<{ subscription: SubscriptionRow; plan: PlanRow; license: { row: Awaited<ReturnType<typeof issueForSubscription>>['row']; fullKey: string } }> {
  const existingLive = await getLiveSubscriptionForUser(db, input.userId);
  if (existingLive) throw AppErrors.conflict('User already has a live subscription.');
  const plan = await getPlanByCode(db, input.planCode);
  if (!plan) throw AppErrors.notFound('plan');

  const [row] = await db
    .insert(subscriptions)
    .values({
      id: newId(),
      userId: input.userId,
      planId: plan.id,
      status: 'lifetime',
      currentPeriodStart: new Date(),
      currentPeriodEnd: null,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      autoRenew: false,
      source: input.source ?? 'manual',
      grantedByAdminId: input.grantedByAdminId,
    })
    .returning();

  const license = await issueForSubscription(db, {
    subscriptionId: row!.id,
    userId: input.userId,
    maxDevices: plan.deviceLimit,
    expiresAt: null,
  });

  await publishSubscriptionChanged(redis, row!, plan);
  return { subscription: row!, plan, license };
}

export async function extendSubscription(
  db: Database,
  redis: Redis,
  subscriptionId: string,
  periodDays: number,
): Promise<{ before: SubscriptionRow; after: SubscriptionRow }> {
  const before = await findSubscriptionById(db, subscriptionId);
  if (!before) throw AppErrors.notFound('subscription');
  if (before.currentPeriodEnd === null) {
    throw AppErrors.conflict('This subscription has no period end to extend (lifetime, or a trial still in progress).');
  }

  const newEnd = new Date(before.currentPeriodEnd.getTime() + periodDays * DAY_MS);
  const [after] = await db.update(subscriptions).set({ currentPeriodEnd: newEnd }).where(eq(subscriptions.id, subscriptionId)).returning();
  const plan = await getPlanById(db, after!.planId);
  if (plan) await publishSubscriptionChanged(redis, after!, plan);
  return { before, after: after! };
}

export async function suspend(
  db: Database,
  redis: Redis,
  subscriptionId: string,
): Promise<{ before: SubscriptionRow; after: SubscriptionRow }> {
  const before = await findSubscriptionById(db, subscriptionId);
  if (!before) throw AppErrors.notFound('subscription');
  if (before.status === 'suspended') throw AppErrors.conflict('Subscription is already suspended.');

  const [after] = await db
    .update(subscriptions)
    // Same constraint as expireDueSubscriptions — 'suspended' is never
    // 'trialing', so trial_ends_at must be cleared here too.
    .set({ status: 'suspended', trialEndsAt: null })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  const plan = await getPlanById(db, after!.planId);
  if (plan) await publishSubscriptionChanged(redis, after!, plan);
  return { before, after: after! };
}

export async function unsuspend(
  db: Database,
  redis: Redis,
  subscriptionId: string,
  targetStatus: SubscriptionStatus,
): Promise<{ before: SubscriptionRow; after: SubscriptionRow }> {
  const before = await findSubscriptionById(db, subscriptionId);
  if (!before) throw AppErrors.notFound('subscription');
  if (before.status !== 'suspended') throw AppErrors.conflict('Subscription is not suspended.');

  const [after] = await db.update(subscriptions).set({ status: targetStatus }).where(eq(subscriptions.id, subscriptionId)).returning();
  const plan = await getPlanById(db, after!.planId);
  if (plan) await publishSubscriptionChanged(redis, after!, plan);
  return { before, after: after! };
}

export async function cancelByAdmin(
  db: Database,
  redis: Redis,
  subscriptionId: string,
  immediate: boolean,
): Promise<{ before: SubscriptionRow; after: SubscriptionRow }> {
  const before = await findSubscriptionById(db, subscriptionId);
  if (!before) throw AppErrors.notFound('subscription');
  if (before.status === 'lifetime') throw AppErrors.conflict('A lifetime subscription cannot be canceled.');

  const now = new Date();
  const patch = immediate
    ? { status: 'canceled' as const, canceledAt: now, endedAt: now, cancelAtPeriodEnd: true, trialEndsAt: null }
    : { cancelAtPeriodEnd: true, canceledAt: now };

  const [after] = await db.update(subscriptions).set(patch).where(eq(subscriptions.id, subscriptionId)).returning();
  const plan = await getPlanById(db, after!.planId);
  if (plan) await publishSubscriptionChanged(redis, after!, plan);

  if (immediate) {
    const license = await findActiveForSubscription(db, subscriptionId);
    if (license) await revokeLicense(db, license.id, 'subscription_canceled');
  }

  return { before, after: after! };
}

// ---------------------------------------------------------------------------
// subscriptions.expire job (also directly unit-testable)
// ---------------------------------------------------------------------------

export async function expireDueSubscriptions(db: Database, redis: Redis): Promise<{ expiredCount: number }> {
  const now = new Date();

  const dueTrials = await db.query.subscriptions.findMany({
    where: and(
      eq(subscriptions.status, 'trialing'),
      isNotNull(subscriptions.trialEndsAt),
      lt(subscriptions.trialEndsAt, now),
      isNull(subscriptions.deletedAt),
    ),
  });

  const dueByPeriod = await db.query.subscriptions.findMany({
    where: and(
      inArray(subscriptions.status, ['active', 'past_due', 'canceled']),
      isNotNull(subscriptions.currentPeriodEnd),
      lt(subscriptions.currentPeriodEnd, now),
      eq(subscriptions.autoRenew, false),
      isNull(subscriptions.deletedAt),
    ),
  });

  const due = [...dueTrials, ...dueByPeriod];

  for (const sub of due) {
    const [after] = await db
      .update(subscriptions)
      // trial_ends_at must be cleared in the same UPDATE — the DB constraint
      // `subscriptions_trial_ends_only_when_trialing` requires it be NULL
      // once status leaves 'trialing' (02-database.md §6.3).
      .set({ status: 'expired', endedAt: now, trialEndsAt: null })
      .where(eq(subscriptions.id, sub.id))
      .returning();

    const license = await findActiveForSubscription(db, sub.id);
    if (license) await revokeLicense(db, license.id, 'subscription_expired');

    const plan = await getPlanById(db, sub.planId);
    if (plan && after) await publishSubscriptionChanged(redis, after, plan);

    await db.insert(notifications).values({
      id: newId(),
      userId: sub.userId,
      type: 'subscription.expired',
      title: 'Your subscription has expired',
      body: null,
      data: { subscriptionId: sub.id },
      deliveredVia: 'in_app',
    });
  }

  return { expiredCount: due.length };
}
