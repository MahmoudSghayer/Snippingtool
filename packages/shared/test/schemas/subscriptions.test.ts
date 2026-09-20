import { describe, expect, it } from 'vitest';

import {
  couponValidateRequestSchema,
  couponValidateResponseSchema,
  entitlementSnapshotSchema,
  licenseValidateRequestSchema,
  paymentDtoSchema,
  planCreateRequestSchema,
  planUpdateRequestSchema,
} from '../../src/schemas/subscriptions.js';

describe('paymentDtoSchema', () => {
  it('accepts a succeeded stripe payment', () => {
    const result = paymentDtoSchema.safeParse({
      id: '0198f2b1-0000-7000-8000-000000000001',
      provider: 'stripe',
      amountCents: 999,
      currency: 'usd',
      status: 'succeeded',
      invoiceUrl: 'https://invoice.stripe.com/i/abc',
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null invoiceUrl', () => {
    const result = paymentDtoSchema.safeParse({
      id: '0198f2b1-0000-7000-8000-000000000001',
      provider: 'manual',
      amountCents: 0,
      currency: 'usd',
      status: 'succeeded',
      invoiceUrl: null,
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid status', () => {
    const result = paymentDtoSchema.safeParse({
      id: '0198f2b1-0000-7000-8000-000000000001',
      provider: 'stripe',
      amountCents: 999,
      currency: 'usd',
      status: 'bogus',
      invoiceUrl: null,
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('entitlementSnapshotSchema', () => {
  it('accepts a fully-populated snapshot', () => {
    const result = entitlementSnapshotSchema.safeParse({
      plan: 'ultimate',
      planName: 'Ultimate',
      status: 'active',
      features: ['ledger.recorder', 'automation.autobuyer'],
      deviceLimit: 3,
      expiresAt: '2026-10-20T00:00:00.000Z',
      currentPeriodEnd: '2026-10-20T00:00:00.000Z',
      license: { keyPrefix: 'SL-9F2K', status: 'active', maxDevices: 3, expiresAt: null },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null expiresAt/currentPeriodEnd/license for a lifetime plan with no license yet', () => {
    const result = entitlementSnapshotSchema.safeParse({
      plan: 'lifetime',
      planName: 'Lifetime',
      status: 'lifetime',
      features: ['ledger.recorder'],
      deviceLimit: 3,
      expiresAt: null,
      currentPeriodEnd: null,
      license: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts the no-subscription-yet shape (all nulls, zero device limit)', () => {
    const result = entitlementSnapshotSchema.safeParse({
      plan: null,
      planName: null,
      status: null,
      features: [],
      deviceLimit: 1,
      expiresAt: null,
      currentPeriodEnd: null,
      license: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing deviceLimit', () => {
    const result = entitlementSnapshotSchema.safeParse({
      plan: 'basic',
      planName: 'Basic',
      status: 'active',
      features: [],
      expiresAt: null,
      currentPeriodEnd: null,
      license: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('licenseValidateRequestSchema', () => {
  it('accepts a license key plus device fingerprint', () => {
    const result = licenseValidateRequestSchema.safeParse({
      licenseKey: 'SL-0410-6105-0R3G-G2RM',
      device: { fingerprint: 'a'.repeat(20) },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a request missing the device fingerprint', () => {
    const result = licenseValidateRequestSchema.safeParse({ licenseKey: 'SL-0410-6105-0R3G-G2RM' });
    expect(result.success).toBe(false);
  });
});

describe('planCreateRequestSchema', () => {
  it('accepts a valid non-lifetime plan', () => {
    const result = planCreateRequestSchema.safeParse({
      code: 'founders-2026',
      name: 'Founders 2026',
      priceCents: 4999,
      currency: 'usd',
      interval: 'month',
      isLifetime: false,
      deviceLimit: 2,
      features: ['ledger.recorder'],
      sortOrder: 5,
      reason: 'new limited-time plan',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an uppercase plan code', () => {
    const result = planCreateRequestSchema.safeParse({
      code: 'FOUNDERS',
      name: 'Founders',
      priceCents: 0,
      interval: 'month',
      deviceLimit: 1,
      features: [],
      reason: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a device limit above 10', () => {
    const result = planCreateRequestSchema.safeParse({
      code: 'huge',
      name: 'Huge',
      priceCents: 0,
      interval: 'month',
      deviceLimit: 11,
      features: [],
      reason: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing reason', () => {
    const result = planCreateRequestSchema.safeParse({
      code: 'no-reason',
      name: 'No Reason',
      priceCents: 0,
      interval: 'month',
      deviceLimit: 1,
      features: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('planUpdateRequestSchema', () => {
  it('accepts a partial update', () => {
    expect(planUpdateRequestSchema.safeParse({ isActive: false, reason: 'archiving' }).success).toBe(true);
  });

  it('rejects an update missing a reason', () => {
    expect(planUpdateRequestSchema.safeParse({ isActive: false }).success).toBe(false);
  });
});

describe('couponValidateRequestSchema / couponValidateResponseSchema', () => {
  it('accepts a validate request', () => {
    expect(couponValidateRequestSchema.safeParse({ code: 'WELCOME10', planCode: 'pro' }).success).toBe(true);
  });

  it('accepts a valid response with no reason', () => {
    const result = couponValidateResponseSchema.safeParse({
      valid: true,
      coupon: {
        id: '0198f2b1-0000-7000-8000-000000000001',
        code: 'WELCOME10',
        type: 'percent',
        value: 10,
        planCodes: ['pro'],
        maxRedemptions: 100,
        redeemedCount: 3,
        expiresAt: null,
        isActive: true,
      },
      discountPreview: '10% off',
      reason: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an invalid response carrying a reason and a null coupon', () => {
    const result = couponValidateResponseSchema.safeParse({
      valid: false,
      coupon: null,
      discountPreview: null,
      reason: 'EXPIRED',
    });
    expect(result.success).toBe(true);
  });
});
