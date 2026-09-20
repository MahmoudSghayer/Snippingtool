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

export const planDtoSchema = z.object({
  id: z.string().uuid(),
  code: z.enum(PLAN_CODES),
  name: z.string().min(1).max(80),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
  interval: z.enum(['month', 'year', 'one_time']),
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
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const checkoutResponseSchema = z.object({
  checkoutUrl: z.string().url(),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

export const billingPortalResponseSchema = z.object({
  portalUrl: z.string().url(),
});
export type BillingPortalResponse = z.infer<typeof billingPortalResponseSchema>;

export const adminGrantSubscriptionRequestSchema = z.object({
  userId: z.string().uuid(),
  planCode: z.enum(PLAN_CODES),
  periodDays: z.number().int().positive().nullable(), // null for lifetime plans
  reason: z.string().min(1).max(1000),
});
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
});
export type CreateCouponRequest = z.infer<typeof createCouponRequestSchema>;
