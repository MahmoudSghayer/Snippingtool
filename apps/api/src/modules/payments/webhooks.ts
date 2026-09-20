// Stripe webhook event handling + idempotency. `receiveWebhookEvent` is the
// single entry point `index.ts`'s `/api/v1/webhooks/stripe` route calls
// after signature verification — see docs/05-subscriptions.md §7 for the
// full per-event-type table this file implements.

import { coupons, notifications, payments, paymentHistory, stripeWebhookEvents, subscriptions, type Database } from '@sl/db';
import { and, eq } from 'drizzle-orm';

import { recordAudit } from '../../lib/audit.js';
import { newId } from '../../lib/ids.js';
import { publishToUser } from '../../ws/publish.js';
import { toAuditSnapshot } from '../admin-subscriptions/admin-action-log.js';
import { redeemCoupon } from '../coupons/service.js';
import { createFlag } from '../flags/service.js';
import { findActiveForSubscription, issueForSubscription, revoke as revokeLicense } from '../licenses/service.js';
import {
  findSubscriptionById,
  getLiveSubscriptionForUser,
  getPlanByCode,
  getPlanById,
  suspend,
  toSubscriptionDto,
  type SubscriptionRow,
} from '../subscriptions/service.js';

import { getSubscriptionPeriod } from './service.js';

import type { Redis } from 'ioredis';
import type Stripe from 'stripe';

type PaymentRow = typeof payments.$inferSelect;
type PaymentStatus = PaymentRow['status'];

/** Newer Stripe API versions moved the subscription that generated an
 * invoice off `invoice.subscription` onto
 * `invoice.parent.subscription_details.subscription` (see
 * `node_modules/stripe`'s `Invoices.d.ts`, `Parent.SubscriptionDetails`). */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!subscription) return null;
  return typeof subscription === 'string' ? subscription : subscription.id;
}

async function recordPayment(
  db: Database,
  input: {
    userId: string;
    subscriptionId: string | null;
    providerPaymentId: string;
    amountCents: number;
    currency: string;
    status: PaymentStatus;
    couponId: string | null;
    invoiceUrl: string | null;
    eventName: string;
    rawEvent: Stripe.Event;
  },
): Promise<void> {
  const rawEvent = input.rawEvent as unknown as Record<string, unknown>;

  const [inserted] = await db
    .insert(payments)
    .values({
      id: newId(),
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      provider: 'stripe',
      providerPaymentId: input.providerPaymentId,
      amountCents: input.amountCents,
      currency: input.currency,
      status: input.status,
      couponId: input.couponId,
      invoiceUrl: input.invoiceUrl,
    })
    .onConflictDoNothing({ target: [payments.provider, payments.providerPaymentId] })
    .returning();

  if (inserted) {
    await db.insert(paymentHistory).values({ id: newId(), paymentId: inserted.id, event: input.eventName, rawEvent });
    return;
  }

  // Row already existed (a status transition on the same provider payment
  // id, e.g. a later invoice event for the same invoice) — update + append.
  const existing = await db.query.payments.findFirst({
    where: and(eq(payments.provider, 'stripe'), eq(payments.providerPaymentId, input.providerPaymentId)),
  });
  if (existing) {
    await db.update(payments).set({ status: input.status }).where(eq(payments.id, existing.id));
    await db.insert(paymentHistory).values({ id: newId(), paymentId: existing.id, event: input.eventName, rawEvent });
  }
}

async function handleCheckoutCompleted(db: Database, redis: Redis, stripe: Stripe, event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const userId = session.metadata?.userId;
  const planCode = session.metadata?.planCode;
  if (!userId || !planCode) return; // not a session this app created

  const plan = await getPlanByCode(db, planCode);
  if (!plan) return;

  const existingLive = await getLiveSubscriptionForUser(db, userId);
  if (existingLive) return; // idempotent guard against a duplicate/late delivery

  let currentPeriodStart = new Date();
  let currentPeriodEnd: Date | null = null;
  let stripeSubscriptionId: string | null = null;

  if (session.mode === 'subscription' && typeof session.subscription === 'string') {
    const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
    const period = getSubscriptionPeriod(stripeSub);
    currentPeriodStart = period.start;
    currentPeriodEnd = period.end;
    stripeSubscriptionId = stripeSub.id;
  }

  const [row] = await db
    .insert(subscriptions)
    .values({
      id: newId(),
      userId,
      planId: plan.id,
      status: 'active',
      currentPeriodStart,
      currentPeriodEnd: plan.isLifetime ? null : currentPeriodEnd,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      autoRenew: !plan.isLifetime,
      source: 'stripe',
      stripeSubscriptionId,
    })
    .returning();

  await issueForSubscription(db, {
    subscriptionId: row!.id,
    userId,
    maxDevices: plan.deviceLimit,
    expiresAt: plan.isLifetime ? null : currentPeriodEnd,
  });

  const couponId = session.metadata?.couponId;
  if (couponId) {
    const coupon = await db.query.coupons.findFirst({ where: eq(coupons.id, couponId) });
    if (coupon) await redeemCoupon(db, coupon, userId, row!.id);
  }

  await recordPayment(db, {
    userId,
    subscriptionId: row!.id,
    providerPaymentId: session.id,
    amountCents: session.amount_total ?? 0,
    currency: session.currency ?? plan.currency,
    status: 'succeeded',
    couponId: couponId || null,
    invoiceUrl: null,
    eventName: event.type,
    rawEvent: event,
  });

  await publishToUser(redis, userId, { type: 'subscription.changed', subscription: toSubscriptionDto(row!, plan) });
  await db.insert(notifications).values({
    id: newId(),
    userId,
    type: 'subscription.activated',
    title: `Welcome to ${plan.name}`,
    body: null,
    data: { subscriptionId: row!.id },
    deliveredVia: 'in_app',
  });
}

async function handleInvoicePaid(db: Database, redis: Redis, stripe: Stripe, event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const stripeSubId = getInvoiceSubscriptionId(invoice);
  if (!stripeSubId) return;

  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.stripeSubscriptionId, stripeSubId) });
  if (!sub) return;

  const stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
  const period = getSubscriptionPeriod(stripeSub);

  const [after] = await db
    .update(subscriptions)
    .set({
      status: sub.status === 'past_due' ? 'active' : sub.status,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    })
    .where(eq(subscriptions.id, sub.id))
    .returning();

  const plan = await getPlanById(db, after!.planId);

  const activeLicense = await findActiveForSubscription(db, sub.id);
  if (!activeLicense && plan) {
    await issueForSubscription(db, { subscriptionId: sub.id, userId: sub.userId, maxDevices: plan.deviceLimit, expiresAt: period.end });
  }

  await recordPayment(db, {
    userId: sub.userId,
    subscriptionId: sub.id,
    providerPaymentId: invoice.id ?? `invoice_${stripeSubId}_${period.start.getTime()}`,
    amountCents: invoice.amount_paid ?? 0,
    currency: invoice.currency ?? plan?.currency ?? 'usd',
    status: 'succeeded',
    couponId: null,
    invoiceUrl: invoice.hosted_invoice_url ?? null,
    eventName: event.type,
    rawEvent: event,
  });

  if (plan) await publishToUser(redis, sub.userId, { type: 'subscription.changed', subscription: toSubscriptionDto(after!, plan) });
}

async function handleInvoicePaymentFailed(db: Database, redis: Redis, event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const stripeSubId = getInvoiceSubscriptionId(invoice);
  if (!stripeSubId) return;

  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.stripeSubscriptionId, stripeSubId) });
  if (!sub) return;

  const [after] = await db.update(subscriptions).set({ status: 'past_due' }).where(eq(subscriptions.id, sub.id)).returning();
  const plan = await getPlanById(db, after!.planId);

  await recordPayment(db, {
    userId: sub.userId,
    subscriptionId: sub.id,
    providerPaymentId: invoice.id ?? `invoice_failed_${stripeSubId}_${Date.now()}`,
    amountCents: invoice.amount_due ?? 0,
    currency: invoice.currency ?? plan?.currency ?? 'usd',
    status: 'failed',
    couponId: null,
    invoiceUrl: invoice.hosted_invoice_url ?? null,
    eventName: event.type,
    rawEvent: event,
  });

  if (plan) await publishToUser(redis, sub.userId, { type: 'subscription.changed', subscription: toSubscriptionDto(after!, plan) });
  await db.insert(notifications).values({
    id: newId(),
    userId: sub.userId,
    type: 'payment.failed',
    title: 'Payment failed',
    body: 'Please update your payment method to keep your subscription active.',
    data: { subscriptionId: sub.id },
    deliveredVia: 'in_app',
  });
}

const STRIPE_STATUS_MAP: Partial<Record<Stripe.Subscription.Status, SubscriptionRow['status']>> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'past_due',
  incomplete: 'past_due',
  incomplete_expired: 'canceled',
  paused: 'suspended',
};

async function handleSubscriptionUpdated(db: Database, redis: Redis, event: Stripe.Event): Promise<void> {
  const stripeSub = event.data.object as Stripe.Subscription;
  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.stripeSubscriptionId, stripeSub.id) });
  if (!sub) return;

  const period = getSubscriptionPeriod(stripeSub);
  const mappedStatus = STRIPE_STATUS_MAP[stripeSub.status] ?? sub.status;

  const [after] = await db
    .update(subscriptions)
    .set({
      status: mappedStatus,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    })
    .where(eq(subscriptions.id, sub.id))
    .returning();

  const plan = await getPlanById(db, after!.planId);
  if (plan) await publishToUser(redis, sub.userId, { type: 'subscription.changed', subscription: toSubscriptionDto(after!, plan) });
}

async function handleSubscriptionDeleted(db: Database, redis: Redis, event: Stripe.Event): Promise<void> {
  const stripeSub = event.data.object as Stripe.Subscription;
  const sub = await db.query.subscriptions.findFirst({ where: eq(subscriptions.stripeSubscriptionId, stripeSub.id) });
  if (!sub) return;

  const [after] = await db
    .update(subscriptions)
    .set({ status: 'canceled', endedAt: new Date() })
    .where(eq(subscriptions.id, sub.id))
    .returning();

  const license = await findActiveForSubscription(db, sub.id);
  if (license) await revokeLicense(db, license.id, 'subscription_ended');

  const plan = await getPlanById(db, after!.planId);
  if (plan) await publishToUser(redis, sub.userId, { type: 'subscription.changed', subscription: toSubscriptionDto(after!, plan) });
}

async function findPaymentByStripeCharge(db: Database, charge: Stripe.Charge): Promise<PaymentRow | undefined> {
  // `charge.invoice` was removed in this Stripe API version — only
  // `payment_intent` and the charge's own id remain as candidates for
  // matching back to the `payments` row we recorded (which stored either a
  // Checkout Session id or an Invoice id as `provider_payment_id`, so this
  // is necessarily best-effort; documented in docs/05-subscriptions.md).
  const candidateIds = [charge.payment_intent, charge.id].filter((v): v is string => typeof v === 'string');
  for (const id of candidateIds) {
    const found = await db.query.payments.findFirst({ where: and(eq(payments.provider, 'stripe'), eq(payments.providerPaymentId, id)) });
    if (found) return found;
  }
  return undefined;
}

async function handleChargeRefunded(db: Database, event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const payment = await findPaymentByStripeCharge(db, charge);
  if (!payment) return;

  await db.update(payments).set({ status: 'refunded' }).where(eq(payments.id, payment.id));
  await db.insert(paymentHistory).values({
    id: newId(),
    paymentId: payment.id,
    event: event.type,
    rawEvent: event as unknown as Record<string, unknown>,
  });
}

async function handleDisputeCreated(db: Database, redis: Redis, event: Stripe.Event): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id;

  const payment =
    (await db.query.payments.findFirst({ where: and(eq(payments.provider, 'stripe'), eq(payments.providerPaymentId, chargeId)) })) ??
    (dispute.payment_intent
      ? await db.query.payments.findFirst({
          where: and(
            eq(payments.provider, 'stripe'),
            eq(payments.providerPaymentId, typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent.id),
          ),
        })
      : undefined);

  if (!payment) return;

  await db.update(payments).set({ status: 'disputed' }).where(eq(payments.id, payment.id));
  await db.insert(paymentHistory).values({
    id: newId(),
    paymentId: payment.id,
    event: event.type,
    rawEvent: event as unknown as Record<string, unknown>,
  });

  await createFlag(db, {
    userId: payment.userId,
    kind: 'chargeback',
    severity: 'critical',
    evidence: { chargeId, amount: dispute.amount, reason: dispute.reason, paymentId: payment.id },
  });

  if (payment.subscriptionId) {
    const sub = await findSubscriptionById(db, payment.subscriptionId);
    if (sub && sub.status !== 'suspended') {
      const { before, after } = await suspend(db, redis, sub.id);
      // System-triggered suspension gets the same audit_logs shape an admin
      // suspend does (docs/05-subscriptions.md §6, "Auto-suspend path"), but
      // no admin_actions row — that log requires a real admin_users.id.
      await recordAudit({
        db,
        actor: { type: 'system', id: null },
        action: 'subscription.suspend',
        entityType: 'subscription',
        entityId: sub.id,
        before: toAuditSnapshot(before),
        after: toAuditSnapshot(after),
        requestId: event.id,
      });
    }
  }
}

export async function processWebhookEvent(db: Database, redis: Redis, stripe: Stripe, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(db, redis, stripe, event);
    case 'invoice.paid':
      return handleInvoicePaid(db, redis, stripe, event);
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(db, redis, event);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(db, redis, event);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(db, redis, event);
    case 'charge.refunded':
      return handleChargeRefunded(db, event);
    case 'charge.dispute.created':
      return handleDisputeCreated(db, redis, event);
    default:
      return undefined;
  }
}

export interface ReceiveWebhookResult {
  alreadyProcessed: boolean;
}

/** Idempotency wrapper (docs/05-subscriptions.md §7): inserts a
 * `stripe_webhook_events` row keyed on `event.id` first; a unique-constraint
 * hit means this event was already received, so processing is skipped and
 * the caller can still respond 200 (Stripe must never see a redelivered
 * event as a failure). `processedAt`/`error` are stamped after the actual
 * handler runs (or throws), so `stripe.reconcile` can find and retry any
 * event that was received but never finished processing. */
export async function receiveWebhookEvent(db: Database, redis: Redis, stripe: Stripe, event: Stripe.Event): Promise<ReceiveWebhookResult> {
  try {
    await db.insert(stripeWebhookEvents).values({
      id: newId(),
      eventId: event.id,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
      processedAt: null,
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '23505') return { alreadyProcessed: true }; // unique_violation on event_id
    throw err;
  }

  try {
    await processWebhookEvent(db, redis, stripe, event);
    await db.update(stripeWebhookEvents).set({ processedAt: new Date() }).where(eq(stripeWebhookEvents.eventId, event.id));
  } catch (err) {
    await db
      .update(stripeWebhookEvents)
      .set({ error: err instanceof Error ? err.message : String(err) })
      .where(eq(stripeWebhookEvents.eventId, event.id));
    throw err;
  }

  return { alreadyProcessed: false };
}
