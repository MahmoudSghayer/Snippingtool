// Coupon validate + redemption integration tests: percent (Stripe-applied,
// tested at the eligibility/preview layer) and free_days (grants instantly,
// no Stripe involvement — docs/05-subscriptions.md §8).

import { coupons, plans, subscriptions } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { createCheckoutSession } from '../../payments/service.js';
import { checkCouponEligibility, redeemCoupon } from '../service.js';

import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';

async function createVerifiedUser(app: FastifyInstance, email: string): Promise<string> {
  const { users } = await import('@sl/db');
  const id = newId();
  await app.db.insert(users).values({ id, email, passwordHash: await hashSecret('irrelevant-password-123'), emailVerifiedAt: new Date() });
  return id;
}

async function insertCoupon(
  app: FastifyInstance,
  input: { code: string; type: 'percent' | 'fixed' | 'free_days' | 'lifetime'; value: number; planIds?: string[]; maxRedemptions?: number | null },
) {
  const [row] = await app.db
    .insert(coupons)
    .values({
      id: newId(),
      code: input.code,
      type: input.type,
      value: input.value,
      planIds: input.planIds ?? [],
      maxRedemptions: input.maxRedemptions ?? null,
      isActive: true,
    })
    .returning();
  return row!;
}

describe('coupons module', () => {
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

  it('POST /coupons/validate previews a percent coupon with a discount description', async () => {
    await insertCoupon(app, { code: 'TENOFF', type: 'percent', value: 10 });

    const res = await app.inject({ method: 'POST', url: '/api/v1/coupons/validate', payload: { code: 'TENOFF', planCode: 'pro' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.coupon.type).toBe('percent');
    expect(body.discountPreview).toBe('10% off');
  });

  it('POST /coupons/validate reports NOT_FOUND for an unknown code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/coupons/validate', payload: { code: 'NOPE', planCode: 'pro' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('NOT_FOUND');
  });

  it('POST /coupons/validate reports PLAN_NOT_ELIGIBLE when the coupon is restricted to a different plan', async () => {
    const ultimatePlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'ultimate') });
    await insertCoupon(app, { code: 'ULTIMATEONLY', type: 'percent', value: 20, planIds: [ultimatePlan!.id] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/coupons/validate', payload: { code: 'ULTIMATEONLY', planCode: 'basic' } });
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('PLAN_NOT_ELIGIBLE');
  });

  it('checkCouponEligibility reports MAX_REDEMPTIONS once the cap is reached', async () => {
    const proPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'pro') });
    const coupon = await insertCoupon(app, { code: 'LIMITED1', type: 'fixed', value: 500, maxRedemptions: 1 });

    const userId = await createVerifiedUser(app, 'redeemer@example.com');
    const [sub] = await app.db
      .insert(subscriptions)
      .values({
        id: newId(),
        userId,
        planId: proPlan!.id,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        source: 'coupon',
      })
      .returning();
    await redeemCoupon(app.db, coupon, userId, sub!.id);

    const anotherUser = await createVerifiedUser(app, 'second-redeemer@example.com');
    const result = await checkCouponEligibility(app.db, 'LIMITED1', proPlan!.id, anotherUser);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('MAX_REDEMPTIONS');
  });

  it('checkCouponEligibility reports ALREADY_REDEEMED for the same user redeeming twice', async () => {
    const proPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'pro') });
    const coupon = await insertCoupon(app, { code: 'ONEPERUSER', type: 'percent', value: 15 });

    const userId = await createVerifiedUser(app, 'once-only@example.com');
    await redeemCoupon(app.db, coupon, userId, null);

    const result = await checkCouponEligibility(app.db, 'ONEPERUSER', proPlan!.id, userId);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('ALREADY_REDEEMED');
  });

  it('a free_days coupon at checkout grants the subscription instantly with no Stripe session', async () => {
    await insertCoupon(app, { code: 'WELCOME14', type: 'free_days', value: 14 });

    const userId = await createVerifiedUser(app, 'free-days@example.com');
    let stripeCheckoutCalled = false;
    const fakeStripe = {
      checkout: { sessions: { create: async () => { stripeCheckoutCalled = true; return { id: 'cs_should_not_be_called', url: 'https://irrelevant' }; } } },
    } as unknown as Stripe;

    const result = await createCheckoutSession(
      fakeStripe,
      app.db,
      app.redis,
      { secretKey: 'sk_test', webhookSecret: 'whsec_test', priceIds: { basic: 'p', pro: 'p', ultimate: 'p', lifetime: 'p' } },
      { userId, email: 'free-days@example.com', planCode: 'pro', successUrl: 'https://app/success', cancelUrl: 'https://app/cancel', couponCode: 'WELCOME14' },
    );

    expect(stripeCheckoutCalled).toBe(false);
    expect(result.kind).toBe('granted');
    if (result.kind === 'granted') {
      expect(result.subscription.status).toBe('active');
      expect(result.subscription.plan.code).toBe('pro');
    }

    const couponRow = await app.db.query.coupons.findFirst({ where: eq(coupons.code, 'WELCOME14') });
    expect(couponRow!.redeemedCount).toBe(1);
  });
});
