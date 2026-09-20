import { describe, expect, it } from 'vitest';

import {
  couponValidateRequestSchema,
  couponValidateResponseSchema,
  entitlementBlobSchema,
  licenseValidateRequestSchema,
  planCreateRequestSchema,
  planUpdateRequestSchema,
} from '../../src/schemas/subscriptions.js';

describe('entitlementBlobSchema', () => {
  it('accepts a fully-populated blob', () => {
    const result = entitlementBlobSchema.safeParse({
      userId: '0198f2b1-0000-7000-8000-000000000001',
      plan: 'ultimate',
      features: ['ledger.recorder', 'automation.autobuyer'],
      deviceLimit: 3,
      expiresAt: '2026-10-20T00:00:00.000Z',
      issuedAt: '2026-09-20T14:32:05.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null expiresAt for a lifetime plan', () => {
    const result = entitlementBlobSchema.safeParse({
      userId: '0198f2b1-0000-7000-8000-000000000001',
      plan: 'lifetime',
      features: ['ledger.recorder'],
      deviceLimit: 3,
      expiresAt: null,
      issuedAt: '2026-09-20T14:32:05.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing issuedAt (required for the offline-grace check)', () => {
    const result = entitlementBlobSchema.safeParse({
      userId: '0198f2b1-0000-7000-8000-000000000001',
      plan: 'basic',
      features: [],
      deviceLimit: 1,
      expiresAt: null,
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
    });
    expect(result.success).toBe(false);
  });
});

describe('planUpdateRequestSchema', () => {
  it('accepts a partial update', () => {
    expect(planUpdateRequestSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('accepts an empty update (no-op)', () => {
    expect(planUpdateRequestSchema.safeParse({}).success).toBe(true);
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
