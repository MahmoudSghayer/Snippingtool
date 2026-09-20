import { z } from 'zod';

import { PLAN_CODES } from '../constants/plans.js';

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'suspended',
  'expired',
  'lifetime',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** `code` and `interval` are plain strings, not restricted to the fixed
 * `PLAN_CODES`/a 3-value interval enum — `plans` is admin-editable data
 * (docs/05-subscriptions.md §1: admins can create plans with any code and
 * any of the five DB-level interval values, e.g. a one-off
 * `founders-2026` plan on a `week` interval), so this public DTO must be
 * able to represent one. Code that specifically wants "one of the five
 * fixed launch plans" imports `PLAN_CODES`/`isPlanCode` from
 * `constants/plans.ts` and narrows there instead of relying on this schema
 * to do it. */
export const planDtoSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
  interval: z.enum(['day', 'week', 'month', 'year', 'one_time']),
  deviceLimit: z.number().int().min(1),
  features: z.array(z.string()),
  isLifetime: z.boolean(),
});
export type PlanDto = z.infer<typeof planDtoSchema>;

export const subscriptionDtoSchema = z.object({
  id: z.string().uuid(),
  plan: planDtoSchema,
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodStart: z.string().datetime().nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  trialEndsAt: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  autoRenew: z.boolean(),
});
export type SubscriptionDto = z.infer<typeof subscriptionDtoSchema>;

export const LICENSE_STATUSES = ['active', 'expired', 'revoked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/** What the extension caches locally for the 24h offline grace window
 * (docs/01-architecture.md, "license bootstrap + heartbeat + offline
 * grace"). Signed server-side; the extension verifies the signature but
 * never re-derives entitlements from anything but this blob or a fresh
 * bootstrap/heartbeat response. */
export const licenseDtoSchema = z.object({
  keyPrefix: z.string().min(1).max(20), // e.g. "SL-9F2K" — never the full key
  status: z.enum(LICENSE_STATUSES),
  maxDevices: z.number().int().min(1),
  expiresAt: z.string().datetime().nullable(),
});
export type LicenseDto = z.infer<typeof licenseDtoSchema>;

export const checkoutRequestSchema = z.object({
  planCode: z.enum(PLAN_CODES),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  couponCode: z.string().min(1).max(40).optional(),
}).strict();
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const checkoutResponseSchema = z.object({
  checkoutUrl: z.string().url(),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

export const billingPortalResponseSchema = z.object({
  portalUrl: z.string().url(),
});
export type BillingPortalResponse = z.infer<typeof billingPortalResponseSchema>;

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'refunded', 'disputed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const paymentDtoSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(['stripe', 'manual']),
  amountCents: z.number().int(),
  currency: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  invoiceUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
});
export type PaymentDto = z.infer<typeof paymentDtoSchema>;

export const adminGrantSubscriptionRequestSchema = z.object({
  userId: z.string().uuid(),
  planCode: z.enum(PLAN_CODES),
  periodDays: z.number().int().positive().nullable(), // null for lifetime plans
  reason: z.string().min(1).max(1000),
}).strict();
export type AdminGrantSubscriptionRequest = z.infer<typeof adminGrantSubscriptionRequestSchema>;

export const COUPON_TYPES = ['percent', 'fixed', 'free_days', 'lifetime'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export const createCouponRequestSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Z0-9_-]+$/, 'Uppercase letters, digits, - and _ only'),
  type: z.enum(COUPON_TYPES),
  value: z.number().min(0),
  planCodes: z.array(z.enum(PLAN_CODES)).min(1),
  maxRedemptions: z.number().int().positive().nullable(),
  expiresAt: z.string().datetime().nullable(),
  reason: z.string().min(1).max(1000),
}).strict();
export type CreateCouponRequest = z.infer<typeof createCouponRequestSchema>;

export const updateCouponRequestSchema = z.object({
  isActive: z.boolean().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  reason: z.string().min(1).max(1000),
}).strict();
export type UpdateCouponRequest = z.infer<typeof updateCouponRequestSchema>;

export const couponDtoSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  type: z.enum(COUPON_TYPES),
  value: z.number(),
  /** Plain strings, not restricted to `PLAN_CODES` — a coupon can restrict
   * itself to any admin-created plan (`planDtoSchema`'s `code` is widened
   * for the same reason). Empty array = "every plan". */
  planCodes: z.array(z.string()),
  maxRedemptions: z.number().int().positive().nullable(),
  redeemedCount: z.number().int().min(0),
  expiresAt: z.string().datetime().nullable(),
  isActive: z.boolean(),
});
export type CouponDto = z.infer<typeof couponDtoSchema>;

export const couponValidateRequestSchema = z.object({
  code: z.string().min(1).max(40),
  planCode: z.enum(PLAN_CODES),
}).strict();
export type CouponValidateRequest = z.infer<typeof couponValidateRequestSchema>;

/** `POST /coupons/validate` response. `discountPreview` is a human-readable
 * summary only (e.g. "20% off", "14 free days", "Lifetime access") — the
 * actual discount is always computed authoritatively at redemption/checkout
 * time, never trusted from a prior validate call. */
export const couponValidateResponseSchema = z.object({
  valid: z.boolean(),
  coupon: couponDtoSchema.nullable(),
  discountPreview: z.string().max(80).nullable(),
  reason: z.enum(['NOT_FOUND', 'EXPIRED', 'MAX_REDEMPTIONS', 'ALREADY_REDEEMED', 'PLAN_NOT_ELIGIBLE']).nullable(),
});
export type CouponValidateResponse = z.infer<typeof couponValidateResponseSchema>;

// ---------------------------------------------------------------------------
// Admin plans CRUD
// ---------------------------------------------------------------------------

export const planCreateRequestSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'Lowercase letters, digits, - and _ only'),
  name: z.string().min(1).max(80),
  description: z.string().max(2000).nullable().optional(),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3).default('usd'),
  interval: z.enum(['day', 'week', 'month', 'year', 'one_time']),
  isLifetime: z.boolean().default(false),
  deviceLimit: z.number().int().min(1).max(10),
  features: z.array(z.string().min(1).max(80)),
  stripePriceId: z.string().min(1).max(200).nullable().optional(),
  sortOrder: z.number().int().default(0),
  reason: z.string().min(1).max(1000),
}).strict();
export type PlanCreateRequest = z.infer<typeof planCreateRequestSchema>;

export const planUpdateRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).nullable().optional(),
  priceCents: z.number().int().min(0).optional(),
  deviceLimit: z.number().int().min(1).max(10).optional(),
  features: z.array(z.string().min(1).max(80)).optional(),
  stripePriceId: z.string().min(1).max(200).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  reason: z.string().min(1).max(1000),
}).strict();
export type PlanUpdateRequest = z.infer<typeof planUpdateRequestSchema>;

// ---------------------------------------------------------------------------
// Licenses
// ---------------------------------------------------------------------------

/** Mirrors `apps/api`'s `EntitlementSnapshot` (`src/lib/entitlements.ts`) —
 * the payload the `EntitlementProvider` signs into the compact JWS the
 * extension caches for the 24h offline-grace window
 * (docs/05-subscriptions.md §4). This schema validates the *decoded* JWT
 * payload's `snapshot` claim, not the JWS envelope itself (the envelope also
 * carries `sub` = userId and `deviceId`, verified separately by `jose`). */
export const entitlementSnapshotSchema = z.object({
  plan: z.string().nullable(),
  planName: z.string().nullable(),
  status: z.string().nullable(),
  features: z.array(z.string()),
  deviceLimit: z.number().int().min(0),
  expiresAt: z.string().datetime().nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  license: z
    .object({
      keyPrefix: z.string(),
      status: z.string(),
      maxDevices: z.number().int(),
      expiresAt: z.string().datetime().nullable(),
    })
    .nullable(),
});
export type EntitlementSnapshotDto = z.infer<typeof entitlementSnapshotSchema>;

export const licenseValidateRequestSchema = z
  .object({
    licenseKey: z.string().min(1).max(40),
    device: z
      .object({
        fingerprint: z.string().min(16).max(256),
        name: z.string().min(1).max(120).optional(),
        browser: z.string().min(1).max(60).optional(),
        os: z.string().min(1).max(60).optional(),
        extensionVersion: z.string().min(1).max(30).optional(),
      })
      .strict(),
  })
  .strict();
export type LicenseValidateRequest = z.infer<typeof licenseValidateRequestSchema>;

export const licenseValidateResponseSchema = z.object({
  status: z.enum(LICENSE_STATUSES),
  entitlements: entitlementSnapshotSchema,
  entitlementJws: z.string().min(1), // signed compact JWS of `entitlements`, cached by the extension
});
export type LicenseValidateResponse = z.infer<typeof licenseValidateResponseSchema>;

export const regenerateLicenseResponseSchema = z.object({
  licenseKey: z.string().min(1), // full key, returned exactly once — see docs/05-subscriptions.md §3
  keyPrefix: z.string().min(1).max(20),
});
export type RegenerateLicenseResponse = z.infer<typeof regenerateLicenseResponseSchema>;

// ---------------------------------------------------------------------------
// Admin subscriptions
// ---------------------------------------------------------------------------

export const adminExtendSubscriptionRequestSchema = z.object({
  periodDays: z.number().int().positive(),
  reason: z.string().min(1).max(1000),
}).strict();
export type AdminExtendSubscriptionRequest = z.infer<typeof adminExtendSubscriptionRequestSchema>;

export const adminSuspendSubscriptionRequestSchema = z.object({
  reason: z.string().min(1).max(1000),
}).strict();
export type AdminSuspendSubscriptionRequest = z.infer<typeof adminSuspendSubscriptionRequestSchema>;

export const adminCancelSubscriptionRequestSchema = z.object({
  reason: z.string().min(1).max(1000),
  immediate: z.boolean().default(false),
}).strict();
export type AdminCancelSubscriptionRequest = z.infer<typeof adminCancelSubscriptionRequestSchema>;

export const adminDeviceLimitOverrideRequestSchema = z.object({
  maxDevices: z.number().int().min(1).max(10),
  reason: z.string().min(1).max(1000),
}).strict();
export type AdminDeviceLimitOverrideRequest = z.infer<typeof adminDeviceLimitOverrideRequestSchema>;
