// Public POST /coupons/validate — a preview endpoint. No auth required, so
// a checkout page can show "10% off" before the user commits; actual
// redemption happens as part of `POST /payments/checkout` or
// `POST /subscriptions/trial`-adjacent flows, never here.

import { couponValidateRequestSchema, couponValidateResponseSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';

import { getPlanByCode } from '../subscriptions/service.js';

import { checkCouponEligibility } from './service.js';

import type { FastifyInstance } from 'fastify';

function describeDiscount(type: string, value: number): string {
  switch (type) {
    case 'percent':
      return `${value}% off`;
    case 'fixed':
      return `$${(value / 100).toFixed(2)} off`;
    case 'free_days':
      return `${value} free day${value === 1 ? '' : 's'}`;
    case 'lifetime':
      return 'Lifetime access';
    default:
      return '';
  }
}

export default fp(
  async function couponsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/coupons/validate',
      {
        schema: {
          tags: ['coupons'],
          summary: 'Preview whether a coupon code is valid for a plan.',
          body: couponValidateRequestSchema,
          response: { 200: couponValidateResponseSchema },
        },
      },
      async (request) => {
        const plan = await getPlanByCode(fastify.db, request.body.planCode);
        if (!plan) {
          return {
            valid: false,
            coupon: null,
            discountPreview: null,
            reason: 'PLAN_NOT_ELIGIBLE' as const,
          };
        }

        // This route deliberately never runs `fastify.authenticate`, so
        // `request.authUser` is always unset here even if the caller sent a
        // token — the per-user "already redeemed" check is intentionally
        // skipped for this anonymous preview and re-checked authoritatively
        // at actual redemption time (checkout/trial), which always has a
        // real `userId`.
        const userId = request.authUser?.id;
        const result = await checkCouponEligibility(fastify.db, request.body.code, plan.id, userId);

        if (!result.eligible || !result.coupon) {
          return {
            valid: false,
            coupon: null,
            discountPreview: null,
            reason: result.reason ?? ('NOT_FOUND' as const),
          };
        }

        return {
          valid: true,
          coupon: {
            id: result.coupon.id,
            code: result.coupon.code,
            type: result.coupon.type,
            value: result.coupon.value,
            planCodes: [request.body.planCode],
            maxRedemptions: result.coupon.maxRedemptions,
            redeemedCount: result.coupon.redeemedCount,
            expiresAt: result.coupon.expiresAt ? result.coupon.expiresAt.toISOString() : null,
            isActive: result.coupon.isActive,
          },
          discountPreview: describeDiscount(result.coupon.type, result.coupon.value),
          reason: null,
        };
      },
    );
  },
  { name: 'module:coupons', dependencies: ['db'] },
);
