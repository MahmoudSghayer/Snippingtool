// Checkout/portal session creation and payment history. Every function that
// talks to Stripe takes a `Stripe` client as its first parameter (never
// reads a module-level singleton) so tests can pass a fake — see
// `stripe-client.ts`'s doc comment and this module's `__tests__/`.

import { payments, type Database } from '@sl/db';
import { and, desc, eq, lt } from 'drizzle-orm';

import { AppErrors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { checkCouponEligibility, redeemCoupon } from '../coupons/service.js';
import { activateManual, getLiveSubscriptionForUser, getPlanByCode, grantLifetime, toSubscriptionDto } from '../subscriptions/service.js';

import type { StripeConfig } from './stripe-config.js';
import type { Redis } from 'ioredis';
import type Stripe from 'stripe';

export type PaymentRow = typeof payments.$inferSelect;

export function unixToDate(seconds: number): Date {
  return new Date(seconds * 1000);
}

/** Newer Stripe API versions moved `current_period_start`/`_end` off the
 * top-level `Subscription` object onto each `SubscriptionItem` (see
 * `node_modules/stripe`'s `Subscriptions.d.ts`) — this reads the first
 * item's period, which is what a single-price subscription (the only kind
 * this app creates) always has. */
export function getSubscriptionPeriod(sub: Stripe.Subscription): { start: Date; end: Date } {
  const item = sub.items.data[0];
  if (!item) throw AppErrors.internal('Stripe subscription has no line items.');
  return { start: unixToDate(item.current_period_start), end: unixToDate(item.current_period_end) };
}

export interface CreateCheckoutInput {
  userId: string;
  email: string;
  planCode: string;
  successUrl: string;
  cancelUrl: string;
  couponCode?: string;
}

export type CreateCheckoutResult =
  | { kind: 'checkout'; checkoutUrl: string }
  | { kind: 'granted'; subscription: ReturnType<typeof toSubscriptionDto> };

/**
 * Creates a Stripe Checkout Session for a paid plan — unless the supplied
 * coupon is a `free_days`/`lifetime` coupon, in which case there is nothing
 * for Stripe to charge and the subscription is granted immediately instead
 * (`docs/05-subscriptions.md` §8, "Coupons without Stripe").
 */
export async function createCheckoutSession(
  stripe: Stripe,
  db: Database,
  redis: Redis,
  config: StripeConfig,
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const existingLive = await getLiveSubscriptionForUser(db, input.userId);
  if (existingLive) throw AppErrors.conflict('You already have an active subscription.');

  const plan = await getPlanByCode(db, input.planCode);
  if (!plan) throw AppErrors.notFound('plan');

  let coupon: Awaited<ReturnType<typeof checkCouponEligibility>>['coupon'] = null;
  if (input.couponCode) {
    const eligibility = await checkCouponEligibility(db, input.couponCode, plan.id, input.userId);
    if (!eligibility.eligible || !eligibility.coupon) {
      throw AppErrors.validation(`Coupon is not valid: ${eligibility.reason ?? 'NOT_FOUND'}`);
    }
    coupon = eligibility.coupon;
  }

  if (coupon && (coupon.type === 'free_days' || coupon.type === 'lifetime')) {
    const granted =
      coupon.type === 'lifetime'
        ? await grantLifetime(db, redis, { userId: input.userId, planCode: input.planCode, grantedByAdminId: null, source: 'coupon' })
        : await activateManual(db, redis, {
            userId: input.userId,
            planCode: input.planCode,
            periodDays: coupon.value,
            grantedByAdminId: null,
            source: 'coupon',
          });
    await redeemCoupon(db, coupon, input.userId, granted.subscription.id);
    return { kind: 'granted', subscription: toSubscriptionDto(granted.subscription, granted.plan) };
  }

  if (!plan.stripePriceId) {
    throw AppErrors.conflict('This plan is not available for Stripe checkout (no stripe_price_id configured).');
  }

  let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
  if (coupon && (coupon.type === 'percent' || coupon.type === 'fixed')) {
    // No persisted Stripe Coupon/PromotionCode id on our `coupons` row (see
    // docs/05-subscriptions.md §5's "dropped 4th check" note for the same
    // schema-gap class of issue) — mint a single-use Stripe Coupon for this
    // one Checkout Session instead of requiring one to be pre-created
    // out-of-band.
    const stripeCoupon = await stripe.coupons.create(
      coupon.type === 'percent'
        ? { percent_off: coupon.value, duration: 'once', name: coupon.code }
        : { amount_off: coupon.value, currency: plan.currency, duration: 'once', name: coupon.code },
    );
    discounts = [{ coupon: stripeCoupon.id }];
  }

  const session = await stripe.checkout.sessions.create({
    mode: plan.isLifetime ? 'payment' : 'subscription',
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer_email: input.email,
    discounts,
    metadata: {
      userId: input.userId,
      planCode: input.planCode,
      couponId: coupon?.id ?? '',
      couponCode: coupon?.code ?? '',
    },
  });

  if (!session.url) throw AppErrors.internal('Stripe did not return a Checkout URL.');
  return { kind: 'checkout', checkoutUrl: session.url };
}

/**
 * Creates a Stripe Customer Portal session. There is no persisted
 * `stripe_customer_id` column on `users`/`subscriptions`
 * (`docs/05-subscriptions.md` §5's schema-gap note applies here too), so
 * this looks the customer up by email — an MVP-scale approximation
 * (multiple Stripe customers sharing one email would be ambiguous) rather
 * than a guaranteed-exact lookup; flagged in the handoff report.
 */
export async function createPortalSession(stripe: Stripe, input: { email: string; returnUrl: string }): Promise<{ portalUrl: string }> {
  const existing = await stripe.customers.list({ email: input.email, limit: 1 });
  const customer = existing.data[0] ?? (await stripe.customers.create({ email: input.email }));

  const session = await stripe.billingPortal.sessions.create({ customer: customer.id, return_url: input.returnUrl });
  return { portalUrl: session.url };
}

export interface PaymentHistoryPage {
  items: PaymentRow[];
  nextCursor: string | null;
}

export async function listPaymentHistory(db: Database, userId: string, limit: number, cursor?: string): Promise<PaymentHistoryPage> {
  const decoded = decodeCursor(cursor);
  const rows = await db.query.payments.findMany({
    where: decoded
      ? and(eq(payments.userId, userId), lt(payments.createdAt, new Date(decoded.v)))
      : eq(payments.userId, userId),
    orderBy: [desc(payments.createdAt)],
    limit: limit + 1,
  });
  return paginate(rows, limit, (row) => row.createdAt.toISOString());
}
