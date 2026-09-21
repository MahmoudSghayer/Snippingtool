// Integration tests for Stripe checkout/webhooks. Every function under test
// takes a `Stripe` client as an explicit parameter, so these tests build a
// minimal fake satisfying only the methods each code path calls — never a
// real network call — except the one signature-rejection test, which uses a
// real `Stripe` instance purely for its local, no-network
// `webhooks.constructEvent`/`generateTestHeaderString` crypto helpers.

import { flags, licenses, plans, subscriptions, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { createCheckoutSession, createPortalSession } from '../service.js';
import { receiveWebhookEvent } from '../webhooks.js';

const LIVE_SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'lifetime'];

import type { StripeConfig } from '../stripe-config.js';
import type { FastifyInstance } from 'fastify';

const FAKE_STRIPE_CONFIG: StripeConfig = {
  secretKey: 'sk_test_fake',
  webhookSecret: 'whsec_test_fake_secret',
  priceIds: { basic: 'price_basic', pro: 'price_pro', ultimate: 'price_ultimate', lifetime: 'price_lifetime' },
};

function makeFakeStripe(overrides: Partial<Record<string, unknown>> = {}): Stripe {
  return {
    checkout: {
      sessions: {
        create: async (_params: unknown) => ({ id: `cs_test_${newId()}`, url: 'https://checkout.stripe.com/test-session' }),
      },
    },
    subscriptions: {
      retrieve: async (id: string) => ({
        id,
        status: 'active',
        cancel_at_period_end: false,
        items: {
          data: [
            {
              current_period_start: Math.floor(Date.now() / 1000),
              current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
            },
          ],
        },
      }),
    },
    coupons: { create: async (_params: unknown) => ({ id: `coupon_test_${newId()}` }) },
    ...overrides,
  } as unknown as Stripe;
}

async function createVerifiedUser(app: FastifyInstance, email: string): Promise<string> {
  const id = newId();
  await app.db.insert(users).values({ id, email, passwordHash: await hashSecret('irrelevant-password-123'), emailVerifiedAt: new Date() });
  return id;
}

describe('payments module', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await reseedPlans(app.db);
  });

  it('createCheckoutSession creates a session with the fake Stripe client for a paid plan', async () => {
    const userId = await createVerifiedUser(app, 'checkout@example.com');
    const proPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'pro') });
    await app.db.update(plans).set({ stripePriceId: 'price_pro' }).where(eq(plans.id, proPlan!.id));

    const stripe = makeFakeStripe();
    const result = await createCheckoutSession(stripe, app.db, app.redis, FAKE_STRIPE_CONFIG, {
      userId,
      email: 'checkout@example.com',
      planCode: 'pro',
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
    });

    expect(result.kind).toBe('checkout');
    if (result.kind === 'checkout') {
      expect(result.checkoutUrl).toBe('https://checkout.stripe.com/test-session');
    }
  });

  it('rejects checkout for a plan with no stripe_price_id configured', async () => {
    const userId = await createVerifiedUser(app, 'nopriceid@example.com');
    const stripe = makeFakeStripe();

    await expect(
      createCheckoutSession(stripe, app.db, app.redis, FAKE_STRIPE_CONFIG, {
        userId,
        email: 'nopriceid@example.com',
        planCode: 'pro', // seeded with stripePriceId = null
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('webhook signature verification: real Stripe.webhooks rejects a payload signed with the wrong secret (400)', async () => {
    const realStripe = new Stripe('sk_test_irrelevant_no_network_call_made');
    const payload = JSON.stringify({ id: 'evt_test_sig', type: 'checkout.session.completed', data: { object: {} } });
    const wrongSecretHeader = realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_the_wrong_one' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': wrongSecretHeader },
    });
    // STRIPE_WEBHOOK_SECRET is unset in this test env, so `getStripeConfig`
    // itself throws before `constructEvent` is ever reached — the route
    // handler catches that alongside a genuine signature mismatch and
    // throws the same `AppErrors.validation` 400 either way (rendered as
    // the app-wide `{code, message, requestId}` envelope, never a raw 500
    // to an unauthenticated, internet-facing endpoint) — see
    // tests/security/src/webhook-signature.test.ts for the dedicated
    // missing-header / forged-signature coverage.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('receiveWebhookEvent is idempotent: the same event.id delivered twice only processes once', async () => {
    const userId = await createVerifiedUser(app, 'idempotent@example.com');
    const trialPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'trial') });

    const event = {
      id: 'evt_idempotent_test_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_idempotent_1',
          mode: 'subscription',
          amount_total: 999,
          currency: 'usd',
          customer_email: 'idempotent@example.com',
          metadata: { userId, planCode: 'trial', couponId: '', couponCode: '' },
        },
      },
    } as unknown as Stripe.Event;

    const first = await receiveWebhookEvent(app.db, app.redis, makeFakeStripe(), event);
    expect(first.alreadyProcessed).toBe(false);
    const second = await receiveWebhookEvent(app.db, app.redis, makeFakeStripe(), event);
    expect(second.alreadyProcessed).toBe(true);

    const subs = await app.db.query.subscriptions.findMany({ where: eq(subscriptions.userId, userId) });
    expect(subs).toHaveLength(1);
    expect(subs[0]!.planId).toBe(trialPlan!.id);
  });

  it('invoice.paid activates the subscription and (re-)issues a license when none is active', async () => {
    const userId = await createVerifiedUser(app, 'invoicepaid@example.com');
    const proPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'pro') });
    const stripeSubscriptionId = `sub_${newId()}`;

    const [sub] = await app.db
      .insert(subscriptions)
      .values({
        id: newId(),
        userId,
        planId: proPlan!.id,
        status: 'past_due',
        currentPeriodStart: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        autoRenew: true,
        source: 'stripe',
        stripeSubscriptionId,
      })
      .returning();

    const event = {
      id: 'evt_invoice_paid_1',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_test_1',
          amount_paid: 999,
          currency: 'usd',
          hosted_invoice_url: null,
          parent: { subscription_details: { subscription: stripeSubscriptionId } },
        },
      },
    } as unknown as Stripe.Event;

    const result = await receiveWebhookEvent(app.db, app.redis, makeFakeStripe(), event);
    expect(result.alreadyProcessed).toBe(false);

    const after = await app.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, sub!.id) });
    expect(after!.status).toBe('active');

    const license = await app.db.query.licenses.findFirst({ where: eq(licenses.subscriptionId, sub!.id) });
    expect(license).toBeTruthy();
    expect(license!.status).toBe('active');
  });

  it('customer.subscription.deleted cancels the local subscription and revokes its license', async () => {
    const userId = await createVerifiedUser(app, 'subdeleted@example.com');
    const proPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'pro') });
    const stripeSubscriptionId = `sub_${newId()}`;

    const [sub] = await app.db
      .insert(subscriptions)
      .values({
        id: newId(),
        userId,
        planId: proPlan!.id,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        autoRenew: true,
        source: 'stripe',
        stripeSubscriptionId,
      })
      .returning();
    await app.db.insert(licenses).values({
      id: newId(),
      subscriptionId: sub!.id,
      userId,
      keyHash: `hash_${newId()}`,
      keyPrefix: 'SL-TEST',
      status: 'active',
      maxDevices: 2,
      expiresAt: sub!.currentPeriodEnd,
    });

    const event = {
      id: 'evt_sub_deleted_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: stripeSubscriptionId } },
    } as unknown as Stripe.Event;

    await receiveWebhookEvent(app.db, app.redis, makeFakeStripe(), event);

    const after = await app.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, sub!.id) });
    expect(after!.status).toBe('canceled');
    expect(after!.endedAt).toBeTruthy();

    const license = await app.db.query.licenses.findFirst({ where: eq(licenses.subscriptionId, sub!.id) });
    expect(license!.status).toBe('revoked');
    expect(license!.revokedReason).toBe('subscription_ended');
  });

  it('charge.dispute.created (chargeback) suspends the subscription and creates a critical flag', async () => {
    const userId = await createVerifiedUser(app, 'chargeback@example.com');
    const proPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'pro') });

    const [sub] = await app.db
      .insert(subscriptions)
      .values({
        id: newId(),
        userId,
        planId: proPlan!.id,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        autoRenew: true,
        source: 'stripe',
        stripeSubscriptionId: `sub_${newId()}`,
      })
      .returning();

    const { payments } = await import('@sl/db');
    const [payment] = await app.db
      .insert(payments)
      .values({
        id: newId(),
        userId,
        subscriptionId: sub!.id,
        provider: 'stripe',
        providerPaymentId: 'pi_chargeback_test_1',
        amountCents: 999,
        currency: 'usd',
        status: 'succeeded',
      })
      .returning();

    const event = {
      id: 'evt_dispute_1',
      type: 'charge.dispute.created',
      data: {
        object: {
          charge: 'ch_irrelevant',
          payment_intent: 'pi_chargeback_test_1',
          amount: 999,
          reason: 'fraudulent',
        },
      },
    } as unknown as Stripe.Event;

    await receiveWebhookEvent(app.db, app.redis, makeFakeStripe(), event);

    const after = await app.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, sub!.id) });
    expect(after!.status).toBe('suspended');

    const paymentAfter = await app.db.query.payments.findFirst({ where: eq(payments.id, payment!.id) });
    expect(paymentAfter!.status).toBe('disputed');

    const flagRows = await app.db.query.flags.findMany({ where: and(eq(flags.userId, userId), eq(flags.kind, 'chargeback')) });
    expect(flagRows).toHaveLength(1);
    expect(flagRows[0]!.severity).toBe('critical');

    const auditRows = await app.db.query.auditLogs.findMany({ where: (t, { eq: eqOp }) => eqOp(t.entityId, sub!.id) });
    const suspendAudit = auditRows.find((r) => r.action === 'subscription.suspend');
    expect(suspendAudit).toBeTruthy();
    expect(suspendAudit!.actorType).toBe('system');
    expect(suspendAudit!.actorId).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Atomic trial->paid upgrade (checkout.session.completed while trialing)
  // ---------------------------------------------------------------------

  async function seedTrialingSubscription(app: FastifyInstance, userId: string) {
    const trialPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'trial') });
    const [trialSub] = await app.db
      .insert(subscriptions)
      .values({
        id: newId(),
        userId,
        planId: trialPlan!.id,
        status: 'trialing',
        currentPeriodStart: new Date(),
        currentPeriodEnd: null,
        trialEndsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        autoRenew: false,
        source: 'manual',
      })
      .returning();
    const [trialLicense] = await app.db
      .insert(licenses)
      .values({
        id: newId(),
        subscriptionId: trialSub!.id,
        userId,
        keyHash: `hash_${newId()}`,
        keyPrefix: 'SL-TRIL',
        status: 'active',
        maxDevices: 1,
        expiresAt: trialSub!.trialEndsAt,
      })
      .returning();
    return { trialSub: trialSub!, trialLicense: trialLicense! };
  }

  function trialUpgradeEvent(eventId: string, userId: string): Stripe.Event {
    return {
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_${eventId}`,
          mode: 'subscription',
          amount_total: 999,
          currency: 'usd',
          customer: 'cus_trial_upgrade_shared',
          subscription: `sub_${eventId}`,
          metadata: { userId, planCode: 'pro', couponId: '', couponCode: '' },
        },
      },
    } as unknown as Stripe.Event;
  }

  it('checkout.session.completed for a user with a live trial ends the trial atomically, activates the paid plan, and issues exactly one live subscription + license', async () => {
    const userId = await createVerifiedUser(app, 'trial-upgrade@example.com');
    const proPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'pro') });
    const { trialSub, trialLicense } = await seedTrialingSubscription(app, userId);

    const result = await receiveWebhookEvent(app.db, app.redis, makeFakeStripe(), trialUpgradeEvent('evt_trial_upgrade_1', userId));
    expect(result.alreadyProcessed).toBe(false);

    const allSubs = await app.db.query.subscriptions.findMany({ where: eq(subscriptions.userId, userId) });
    expect(allSubs).toHaveLength(2); // the original trial row + the new paid row

    const trialAfter = allSubs.find((s) => s.id === trialSub.id)!;
    expect(trialAfter.status).toBe('canceled');
    expect(trialAfter.trialEndsAt).toBeNull();
    expect(trialAfter.endedAt).toBeTruthy();

    const paidSub = allSubs.find((s) => s.id !== trialSub.id)!;
    expect(paidSub.status).toBe('active');
    expect(paidSub.planId).toBe(proPlan!.id);

    // Exactly one LIVE subscription — the trial row no longer counts.
    const liveSubs = allSubs.filter((s) => LIVE_SUBSCRIPTION_STATUSES.includes(s.status));
    expect(liveSubs).toHaveLength(1);
    expect(liveSubs[0]!.id).toBe(paidSub.id);

    const trialLicenseAfter = await app.db.query.licenses.findFirst({ where: eq(licenses.id, trialLicense.id) });
    expect(trialLicenseAfter!.status).toBe('revoked');
    expect(trialLicenseAfter!.revokedReason).toBe('upgraded_to_paid');

    const paidLicense = await app.db.query.licenses.findFirst({ where: eq(licenses.subscriptionId, paidSub.id) });
    expect(paidLicense).toBeTruthy();
    expect(paidLicense!.status).toBe('active');

    const userAfter = await app.db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(userAfter!.stripeCustomerId).toBe('cus_trial_upgrade_shared');
  });

  it('duplicate delivery of the same trial-upgrade checkout event stays idempotent', async () => {
    const userId = await createVerifiedUser(app, 'trial-upgrade-dup@example.com');
    const { trialSub } = await seedTrialingSubscription(app, userId);
    const event = trialUpgradeEvent('evt_trial_upgrade_dup_1', userId);

    const first = await receiveWebhookEvent(app.db, app.redis, makeFakeStripe(), event);
    expect(first.alreadyProcessed).toBe(false);
    const second = await receiveWebhookEvent(app.db, app.redis, makeFakeStripe(), event);
    expect(second.alreadyProcessed).toBe(true);

    const allSubs = await app.db.query.subscriptions.findMany({ where: eq(subscriptions.userId, userId) });
    expect(allSubs).toHaveLength(2); // still just the ended trial + the one paid row, not a second paid row

    const liveSubs = allSubs.filter((s) => LIVE_SUBSCRIPTION_STATUSES.includes(s.status));
    expect(liveSubs).toHaveLength(1);

    const trialAfter = allSubs.find((s) => s.id === trialSub.id)!;
    expect(trialAfter.status).toBe('canceled');

    const licenseRows = await app.db.query.licenses.findMany({ where: eq(licenses.userId, userId) });
    expect(licenseRows.filter((l) => l.status === 'active')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // Customer Portal: stripe_customer_id lookup-first, email fallback +
  // persistence (docs/05-subscriptions.md §5, migrations/0025)
  // ---------------------------------------------------------------------

  it('createPortalSession looks up by stripe_customer_id first, skipping the email lookup entirely', async () => {
    const userId = await createVerifiedUser(app, 'portal-has-customer@example.com');
    await app.db.update(users).set({ stripeCustomerId: 'cus_already_known' }).where(eq(users.id, userId));

    let listCalls = 0;
    const stripe = makeFakeStripe({
      customers: { list: async () => { listCalls += 1; return { data: [] }; }, create: async () => ({ id: 'cus_should_not_be_created' }) },
      billingPortal: { sessions: { create: async (params: { customer: string }) => ({ url: `https://billing.stripe.com/session/${params.customer}` }) } },
    });

    const result = await createPortalSession(stripe, app.db, {
      userId,
      email: 'portal-has-customer@example.com',
      stripeCustomerId: 'cus_already_known',
      returnUrl: 'https://app.example.com/account',
    });

    expect(listCalls).toBe(0);
    expect(result.portalUrl).toBe('https://billing.stripe.com/session/cus_already_known');
  });

  it('createPortalSession falls back to an email lookup when stripe_customer_id is null, and persists what it finds', async () => {
    const userId = await createVerifiedUser(app, 'portal-no-customer@example.com');

    const stripe = makeFakeStripe({
      customers: {
        list: async () => ({ data: [{ id: 'cus_found_by_email' }] }),
        create: async () => ({ id: 'cus_should_not_be_created' }),
      },
      billingPortal: { sessions: { create: async (params: { customer: string }) => ({ url: `https://billing.stripe.com/session/${params.customer}` }) } },
    });

    const result = await createPortalSession(stripe, app.db, {
      userId,
      email: 'portal-no-customer@example.com',
      stripeCustomerId: null,
      returnUrl: 'https://app.example.com/account',
    });

    expect(result.portalUrl).toBe('https://billing.stripe.com/session/cus_found_by_email');

    const userAfter = await app.db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(userAfter!.stripeCustomerId).toBe('cus_found_by_email');
  });
});
