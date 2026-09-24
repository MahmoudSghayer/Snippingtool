// /api/v1/payment-claims — a buyer submits the PayPal transaction ID for a
// pass they paid for through PayPal.me — and /api/v1/admin/payment-claims,
// the queue an admin works through to approve or reject them. See
// ./service.ts for why this exists instead of a payment webhook.

import { paymentClaims } from '@sl/db';
import {
  adminPaymentClaimDtoSchema,
  adminPaymentClaimListQuerySchema,
  createPaymentClaimRequestSchema,
  paginatedResponseSchema,
  paymentClaimDtoSchema,
  rejectPaymentClaimRequestSchema,
  subscriptionDtoSchema,
} from '@sl/shared';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { PAYMENTS_NOTIFY_JOB } from '../../jobs/payments.notify.job.js';
import { recordAudit } from '../../lib/audit.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { ADMIN_RATE_LIMIT } from '../../lib/rate-limit-tiers.js';
import {
  recordAdminAction,
  requireAdminUsersRowId,
} from '../admin-subscriptions/admin-action-log.js';
import { toSubscriptionDto } from '../subscriptions/service.js';

import { approveClaim, createClaim, rejectClaim, toPaymentClaimDto } from './service.js';

import type { FastifyInstance } from 'fastify';

const idParams = z.object({ id: z.string().uuid() });

/** Submitting a claim is cheap for the buyer and costs an admin a review,
 * so it gets its own tight limit. */
const CLAIM_RATE_LIMIT = { max: 10, timeWindow: 60 * 60_000 };

export default fp(
  async function paymentClaimsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/payment-claims',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: CLAIM_RATE_LIMIT },
        schema: {
          tags: ['payment-claims'],
          summary: 'Submit the PayPal transaction ID for a pass you paid for.',
          body: createPaymentClaimRequestSchema,
          response: { 201: paymentClaimDtoSchema },
        },
      },
      async (request, reply) => {
        const { claim, plan } = await createClaim(fastify.db, {
          userId: request.authUser!.id,
          planCode: request.body.planCode,
          paypalTransactionId: request.body.paypalTransactionId,
          note: request.body.note,
        });
        // Tell the operator (jobs/payments.notify.job.ts). The claim is
        // already saved and listed in admin, so a queue hiccup must not fail
        // the buyer's request.
        await fastify.enqueue(PAYMENTS_NOTIFY_JOB, { claimId: claim.id }).catch((err: unknown) => {
          request.log.warn({ err, claimId: claim.id }, 'could not enqueue payments.notify');
        });
        return reply.status(201).send(toPaymentClaimDto(claim, plan.name));
      },
    );

    app.get(
      '/api/v1/payment-claims',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['payment-claims'],
          summary: 'Your submitted payments, newest first.',
          response: { 200: z.object({ items: z.array(paymentClaimDtoSchema) }) },
        },
      },
      async (request) => {
        const rows = await fastify.db.query.paymentClaims.findMany({
          where: and(
            eq(paymentClaims.userId, request.authUser!.id),
            isNull(paymentClaims.deletedAt),
          ),
          orderBy: [desc(paymentClaims.createdAt)],
          limit: 20,
        });
        const names = await planNames(fastify);
        return { items: rows.map((r) => toPaymentClaimDto(r, names.get(r.planCode) ?? null)) };
      },
    );

    app.get(
      '/api/v1/admin/payment-claims',
      {
        onRequest: [fastify.requirePermission('subscriptions.read')],
        schema: {
          tags: ['admin-payment-claims'],
          summary: 'Submitted PayPal payments to review, newest first.',
          querystring: adminPaymentClaimListQuerySchema,
          response: { 200: paginatedResponseSchema(adminPaymentClaimDtoSchema) },
        },
      },
      async (request) => {
        const { status, cursor: cursorRaw, limit } = request.query;
        const cursor = decodeCursor(cursorRaw);
        const conditions = [isNull(paymentClaims.deletedAt)];
        if (status) conditions.push(eq(paymentClaims.status, status));
        if (cursor) conditions.push(lt(paymentClaims.createdAt, new Date(cursor.v)));

        const rows = await fastify.db.query.paymentClaims.findMany({
          where: and(...conditions),
          with: { user: { columns: { id: true, email: true } } },
          orderBy: [desc(paymentClaims.createdAt)],
          limit: limit + 1,
        });
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1);
        const names = await planNames(fastify);

        return {
          items: items.map((r) => ({
            ...toPaymentClaimDto(r, names.get(r.planCode) ?? null),
            user: { id: r.user.id, email: r.user.email },
          })),
          nextCursor:
            hasMore && last ? encodeCursor({ v: last.createdAt.toISOString(), id: last.id }) : null,
        };
      },
    );

    app.post(
      '/api/v1/admin/payment-claims/:id/approve',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: ADMIN_RATE_LIMIT },
        schema: {
          tags: ['admin-payment-claims'],
          summary: 'Approve a PayPal payment: issues or extends the pass.',
          params: idParams,
          response: {
            200: z.object({ claim: paymentClaimDtoSchema, subscription: subscriptionDtoSchema }),
          },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { claim, subscription, plan } = await approveClaim(fastify.db, fastify.redis, {
          claimId: request.params.id,
          adminUserRowId,
        });

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'payment_claim.approve',
          targetType: 'payment_claim',
          targetId: claim.id,
          reason: `PayPal ${claim.paypalTransactionId}`,
          metadata: {
            userId: claim.userId,
            planCode: claim.planCode,
            subscriptionId: subscription.id,
          },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'payment_claim.approve',
          entityType: 'payment_claim',
          entityId: claim.id,
          before: { status: 'pending' },
          after: { status: claim.status, subscriptionId: subscription.id },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return {
          claim: toPaymentClaimDto(claim, plan.name),
          subscription: toSubscriptionDto(subscription, plan),
        };
      },
    );

    app.post(
      '/api/v1/admin/payment-claims/:id/reject',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        preHandler: [fastify.verifyCsrf],
        config: { rateLimit: ADMIN_RATE_LIMIT },
        schema: {
          tags: ['admin-payment-claims'],
          summary: 'Reject a PayPal payment claim, with a reason the buyer sees.',
          params: idParams,
          body: rejectPaymentClaimRequestSchema,
          response: { 200: paymentClaimDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const claim = await rejectClaim(fastify.db, {
          claimId: request.params.id,
          adminUserRowId,
          reason: request.body.reason,
        });

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'payment_claim.reject',
          targetType: 'payment_claim',
          targetId: claim.id,
          reason: request.body.reason,
          metadata: { userId: claim.userId, planCode: claim.planCode },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'payment_claim.reject',
          entityType: 'payment_claim',
          entityId: claim.id,
          before: { status: 'pending' },
          after: { status: claim.status, rejectReason: claim.rejectReason },
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        const names = await planNames(fastify);
        return toPaymentClaimDto(claim, names.get(claim.planCode) ?? null);
      },
    );
  },
  { name: 'module:payment-claims', dependencies: ['auth', 'db', 'redis', 'queues'] },
);

async function planNames(fastify: FastifyInstance): Promise<Map<string, string>> {
  const rows = await fastify.db.query.plans.findMany({ columns: { code: true, name: true } });
  return new Map(rows.map((r) => [r.code, r.name]));
}
