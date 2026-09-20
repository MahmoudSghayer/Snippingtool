// Admin coupon CRUD: create/update (disable), list. `free_days`/`lifetime`
// coupons never touch Stripe (docs/05-subscriptions.md §8); redemption
// itself happens through `modules/payments`/`modules/subscriptions`, not
// here — this module only manages the coupon definitions.

import { couponDtoSchema, createCouponRequestSchema, updateCouponRequestSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { recordAdminAction, requireAdminUsersRowId, toAuditSnapshot } from '../admin-subscriptions/admin-action-log.js';
import { createCoupon, listAllCoupons, resolvePlanCodes, updateCoupon, type CouponRow } from '../coupons/service.js';

import type { Database } from '@sl/db';
import type { FastifyInstance } from 'fastify';

export const autoPrefix = '/api/v1/admin/coupons';

async function toCouponDto(db: Database, row: CouponRow) {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    planCodes: await resolvePlanCodes(db, row.planIds),
    maxRedemptions: row.maxRedemptions,
    redeemedCount: row.redeemedCount,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    isActive: row.isActive,
  };
}

export default fp(
  async function adminCouponsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/coupons',
      {
        onRequest: [fastify.requirePermission('coupons.write')],
        schema: {
          tags: ['admin-coupons'],
          summary: 'List every coupon.',
          response: { 200: z.object({ items: z.array(couponDtoSchema) }) },
        },
      },
      async () => {
        const rows = await listAllCoupons(fastify.db);
        return { items: await Promise.all(rows.map((row) => toCouponDto(fastify.db, row))) };
      },
    );

    app.post(
      '/api/v1/admin/coupons',
      {
        onRequest: [fastify.requirePermission('coupons.write')],
        schema: {
          tags: ['admin-coupons'],
          summary: 'Create a coupon (percent/fixed/free_days/lifetime).',
          body: createCouponRequestSchema,
          response: { 201: couponDtoSchema },
        },
      },
      async (request, reply) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const row = await createCoupon(fastify.db, {
          code: request.body.code,
          type: request.body.type,
          value: request.body.value,
          planCodes: request.body.planCodes,
          maxRedemptions: request.body.maxRedemptions,
          expiresAt: request.body.expiresAt,
          createdBy: request.authUser!.id,
        });

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'coupon.create',
          targetType: 'coupon',
          targetId: row.id,
          reason: request.body.reason,
          metadata: { code: row.code, type: row.type },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'coupon.create',
          entityType: 'coupon',
          entityId: row.id,
          before: null,
          after: toAuditSnapshot(row),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return reply.status(201).send(await toCouponDto(fastify.db, row));
      },
    );

    app.patch(
      '/api/v1/admin/coupons/:id',
      {
        onRequest: [fastify.requirePermission('coupons.write')],
        schema: {
          tags: ['admin-coupons'],
          summary: 'Update a coupon (activate/deactivate, extend, change max redemptions).',
          params: z.object({ id: z.string().uuid() }),
          body: updateCouponRequestSchema,
          response: { 200: couponDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { before, after } = await updateCoupon(
          fastify.db,
          request.params.id,
          {
            isActive: request.body.isActive,
            maxRedemptions: request.body.maxRedemptions,
            expiresAt: request.body.expiresAt,
          },
          request.authUser!.id,
        );

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'coupon.update',
          targetType: 'coupon',
          targetId: after.id,
          reason: request.body.reason,
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'coupon.update',
          entityType: 'coupon',
          entityId: after.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toCouponDto(fastify.db, after);
      },
    );
  },
  { name: 'module:admin-coupons', dependencies: ['auth', 'db'] },
);
