// PayPal.me payments (migrations/0031). A PayPal.me payment carries no order
// data and sends no webhook, so the buyer tells us they paid: they submit the
// PayPal transaction ID for a plan, and an admin checks it against the PayPal
// account. Approval is what issues the pass. It also records a `payments`
// row, so the revenue KPIs (lib/analytics/kpi.ts) count PayPal income the
// same way they counted Stripe income.

import { paymentClaims, payments, type Database } from '@sl/db';
import { isPurchasablePlan, PLAN_CATALOGUE, type PaymentClaimDto } from '@sl/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { AppErrors, isUniqueViolation } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import {
  activateManual,
  endTrialForUpgrade,
  extendSubscription,
  getLiveSubscriptionForUser,
  getPlanByCode,
  type PlanRow,
  type SubscriptionRow,
} from '../subscriptions/service.js';

import type { Redis } from 'ioredis';

export type PaymentClaimRow = typeof paymentClaims.$inferSelect;

/** A buyer can't pile up unreviewed claims; a handful covers a typo'd ID
 * resubmitted correctly. */
const MAX_PENDING_CLAIMS_PER_USER = 3;

export function toPaymentClaimDto(row: PaymentClaimRow, planName: string | null): PaymentClaimDto {
  return {
    id: row.id,
    planCode: row.planCode,
    planName,
    amountCents: row.amountCents,
    currency: row.currency,
    paypalTransactionId: row.paypalTransactionId,
    note: row.note,
    status: row.status,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

export async function createClaim(
  db: Database,
  input: { userId: string; planCode: string; paypalTransactionId: string; note?: string },
): Promise<{ claim: PaymentClaimRow; plan: PlanRow }> {
  if (!isPurchasablePlan(input.planCode)) {
    throw AppErrors.validation("This plan can't be bought yet.", { planCode: input.planCode });
  }
  const plan = await getPlanByCode(db, input.planCode);
  if (!plan || !plan.isActive) throw AppErrors.notFound('plan');

  const pending = await db.query.paymentClaims.findMany({
    columns: { id: true },
    where: and(
      eq(paymentClaims.userId, input.userId),
      eq(paymentClaims.status, 'pending'),
      isNull(paymentClaims.deletedAt),
    ),
  });
  if (pending.length >= MAX_PENDING_CLAIMS_PER_USER) {
    throw AppErrors.conflict(
      'You already have payments waiting for review. We will check them soon.',
    );
  }

  try {
    const [claim] = await db
      .insert(paymentClaims)
      .values({
        id: newId(),
        userId: input.userId,
        planCode: plan.code,
        amountCents: plan.priceCents,
        currency: plan.currency,
        paypalTransactionId: input.paypalTransactionId,
        note: input.note ?? null,
      })
      .returning();
    return { claim: claim!, plan };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppErrors.conflict('This PayPal transaction ID has already been submitted.');
    }
    throw err;
  }
}

/** Approves a pending claim and gives the buyer their pass:
 *  - no live subscription: a new one for the pass length;
 *  - a live trial: the trial ends and the pass replaces it;
 *  - a live pass on the same plan: it is extended by the pass length.
 * Anything else (a pass on another plan, a suspended account) is left for
 * an admin to sort out in Subscriptions first.
 *
 * The claim is marked approved *before* the pass is issued, with a
 * `status = 'pending'` guard, so two admins clicking Approve at once can't
 * issue two passes. If issuing fails, the claim goes back to pending. */
export async function approveClaim(
  db: Database,
  redis: Redis,
  input: { claimId: string; adminUserRowId: string },
): Promise<{ claim: PaymentClaimRow; subscription: SubscriptionRow; plan: PlanRow }> {
  const existing = await findClaim(db, input.claimId);
  if (existing.status !== 'pending') {
    throw AppErrors.conflict(`This payment was already ${existing.status}.`);
  }
  const plan = await getPlanByCode(db, existing.planCode);
  if (!plan) throw AppErrors.notFound('plan');
  const passDays =
    existing.planCode in PLAN_CATALOGUE
      ? PLAN_CATALOGUE[existing.planCode as keyof typeof PLAN_CATALOGUE].passDays
      : null;
  if (passDays === null) {
    throw AppErrors.conflict(
      `${plan.name} passes can't be approved yet: the pass has no fixed length configured.`,
    );
  }

  const [claimed] = await db
    .update(paymentClaims)
    .set({ status: 'approved', reviewedAt: new Date(), reviewedByAdminId: input.adminUserRowId })
    .where(and(eq(paymentClaims.id, existing.id), eq(paymentClaims.status, 'pending')))
    .returning();
  if (!claimed) throw AppErrors.conflict('This payment was reviewed by someone else just now.');

  let subscription: SubscriptionRow;
  try {
    subscription = await issuePass(db, redis, {
      userId: existing.userId,
      plan,
      passDays,
      adminUserRowId: input.adminUserRowId,
    });
  } catch (err) {
    await db
      .update(paymentClaims)
      .set({ status: 'pending', reviewedAt: null, reviewedByAdminId: null })
      .where(eq(paymentClaims.id, existing.id));
    throw err;
  }

  const [claim] = await db
    .update(paymentClaims)
    .set({ subscriptionId: subscription.id })
    .where(eq(paymentClaims.id, existing.id))
    .returning();

  await db.insert(payments).values({
    id: newId(),
    userId: existing.userId,
    subscriptionId: subscription.id,
    provider: 'manual',
    providerPaymentId: `paypal:${existing.paypalTransactionId}`,
    amountCents: existing.amountCents,
    currency: existing.currency,
    status: 'succeeded',
  });

  return { claim: claim!, subscription, plan };
}

async function issuePass(
  db: Database,
  redis: Redis,
  input: { userId: string; plan: PlanRow; passDays: number; adminUserRowId: string },
): Promise<SubscriptionRow> {
  const live = await getLiveSubscriptionForUser(db, input.userId);

  if (live?.status === 'active' && live.planId === input.plan.id) {
    const { after } = await extendSubscription(db, redis, live.id, input.passDays);
    return after;
  }
  if (live?.status === 'trialing') {
    await endTrialForUpgrade(db, live);
  } else if (live) {
    throw AppErrors.conflict(
      `The user has a live ${live.status} subscription on another plan. Change it in Subscriptions first.`,
    );
  }

  const { subscription } = await activateManual(db, redis, {
    userId: input.userId,
    planCode: input.plan.code,
    periodDays: input.passDays,
    grantedByAdminId: input.adminUserRowId,
  });
  return subscription;
}

export async function rejectClaim(
  db: Database,
  input: { claimId: string; adminUserRowId: string; reason: string },
): Promise<PaymentClaimRow> {
  const existing = await findClaim(db, input.claimId);
  const [row] = await db
    .update(paymentClaims)
    .set({
      status: 'rejected',
      rejectReason: input.reason,
      reviewedAt: new Date(),
      reviewedByAdminId: input.adminUserRowId,
    })
    .where(and(eq(paymentClaims.id, existing.id), eq(paymentClaims.status, 'pending')))
    .returning();
  if (!row) throw AppErrors.conflict(`This payment was already ${existing.status}.`);
  return row;
}

async function findClaim(db: Database, claimId: string): Promise<PaymentClaimRow> {
  const row = await db.query.paymentClaims.findFirst({
    where: and(eq(paymentClaims.id, claimId), isNull(paymentClaims.deletedAt)),
  });
  if (!row) throw AppErrors.notFound('payment claim');
  return row;
}
