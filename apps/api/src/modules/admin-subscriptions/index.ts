// Admin subscription + license operations: activate (manual grant), extend,
// suspend/unsuspend, cancel, grant lifetime, set a per-license device-limit
// override. Every mutation is permission-gated (`subscriptions.write`),
// requires a `reason`, and writes both an `admin_actions` row and an
// `audit_logs` row (before/after) — docs/05-subscriptions.md §8.

import { licenses } from '@sl/db';
import {
  adminCancelSubscriptionRequestSchema,
  adminDeviceLimitOverrideRequestSchema,
  adminExtendSubscriptionRequestSchema,
  adminSuspendSubscriptionRequestSchema,
  subscriptionDtoSchema,
  SUBSCRIPTION_STATUSES,
} from '@sl/shared';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { AppErrors } from '../../lib/errors.js';
import {
  activateManual,
  cancelByAdmin,
  extendSubscription,
  getPlanById,
  grantLifetime,
  suspend,
  toSubscriptionDto,
  unsuspend,
} from '../subscriptions/service.js';

import { recordAdminAction, requireAdminUsersRowId, toAuditSnapshot } from './admin-action-log.js';

import type { FastifyInstance } from 'fastify';

const activateBodySchema = z.object({
  planCode: z.string().min(1).max(40),
  periodDays: z.number().int().positive(),
  reason: z.string().min(1).max(1000),
});

const grantLifetimeBodySchema = z.object({
  planCode: z.string().min(1).max(40),
  reason: z.string().min(1).max(1000),
});

const idParams = z.object({ id: z.string().uuid() });
const userIdParams = z.object({ userId: z.string().uuid() });

export default fp(
  async function adminSubscriptionsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/admin/subscriptions/:userId/activate',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        schema: {
          tags: ['admin-subscriptions'],
          summary: 'Manually activate a subscription for a user (plan + period).',
          params: userIdParams,
          body: activateBodySchema,
          response: { 201: subscriptionDtoSchema },
        },
      },
      async (request, reply) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { subscription, plan } = await activateManual(fastify.db, fastify.redis, {
          userId: request.params.userId,
          planCode: request.body.planCode,
          periodDays: request.body.periodDays,
          grantedByAdminId: adminUserRowId,
        });

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'subscription.activate',
          targetType: 'subscription',
          targetId: subscription.id,
          reason: request.body.reason,
          metadata: { userId: request.params.userId, planCode: request.body.planCode, periodDays: request.body.periodDays },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'subscription.activate',
          entityType: 'subscription',
          entityId: subscription.id,
          before: null,
          after: toAuditSnapshot(subscription),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return reply.status(201).send(toSubscriptionDto(subscription, plan));
      },
    );

    app.post(
      '/api/v1/admin/subscriptions/:userId/grant-lifetime',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        schema: {
          tags: ['admin-subscriptions'],
          summary: 'Grant lifetime access on a plan.',
          params: userIdParams,
          body: grantLifetimeBodySchema,
          response: { 201: subscriptionDtoSchema },
        },
      },
      async (request, reply) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { subscription, plan } = await grantLifetime(fastify.db, fastify.redis, {
          userId: request.params.userId,
          planCode: request.body.planCode,
          grantedByAdminId: adminUserRowId,
        });

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'subscription.grant_lifetime',
          targetType: 'subscription',
          targetId: subscription.id,
          reason: request.body.reason,
          metadata: { userId: request.params.userId, planCode: request.body.planCode },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'subscription.grant_lifetime',
          entityType: 'subscription',
          entityId: subscription.id,
          before: null,
          after: toAuditSnapshot(subscription),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return reply.status(201).send(toSubscriptionDto(subscription, plan));
      },
    );

    app.post(
      '/api/v1/admin/subscriptions/:id/extend',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        schema: {
          tags: ['admin-subscriptions'],
          summary: 'Extend a subscription by N days.',
          params: idParams,
          body: adminExtendSubscriptionRequestSchema,
          response: { 200: subscriptionDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { before, after } = await extendSubscription(fastify.db, fastify.redis, request.params.id, request.body.periodDays);
        const plan = await getPlanById(fastify.db, after.planId);
        if (!plan) throw AppErrors.internal('Plan not found for subscription.');

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'subscription.extend',
          targetType: 'subscription',
          targetId: after.id,
          reason: request.body.reason,
          metadata: { periodDays: request.body.periodDays },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'subscription.extend',
          entityType: 'subscription',
          entityId: after.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toSubscriptionDto(after, plan);
      },
    );

    app.post(
      '/api/v1/admin/subscriptions/:id/suspend',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        schema: {
          tags: ['admin-subscriptions'],
          summary: 'Suspend a subscription.',
          params: idParams,
          body: adminSuspendSubscriptionRequestSchema,
          response: { 200: subscriptionDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { before, after } = await suspend(fastify.db, fastify.redis, request.params.id);
        const plan = await getPlanById(fastify.db, after.planId);
        if (!plan) throw AppErrors.internal('Plan not found for subscription.');

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'subscription.suspend',
          targetType: 'subscription',
          targetId: after.id,
          reason: request.body.reason,
          // previousStatus lets `unsuspend` revert to exactly what it was —
          // see docs/05-subscriptions.md §8's "Unsuspend" row.
          metadata: { previousStatus: before.status },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'subscription.suspend',
          entityType: 'subscription',
          entityId: after.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toSubscriptionDto(after, plan);
      },
    );

    app.post(
      '/api/v1/admin/subscriptions/:id/unsuspend',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        schema: {
          tags: ['admin-subscriptions'],
          summary: 'Unsuspend a subscription, reverting to its pre-suspend status.',
          params: idParams,
          body: z.object({ reason: z.string().min(1).max(1000) }),
          response: { 200: subscriptionDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);

        const lastSuspend = await fastify.db.query.adminActions.findFirst({
          where: (t, { and, eq: eqOp }) => and(eqOp(t.targetType, 'subscription'), eqOp(t.targetId, request.params.id), eqOp(t.action, 'subscription.suspend')),
          orderBy: (t, { desc }) => [desc(t.occurredAt)],
        });
        const previousStatus = (lastSuspend?.metadata as { previousStatus?: string } | undefined)?.previousStatus;
        const targetStatus = SUBSCRIPTION_STATUSES.includes(previousStatus as (typeof SUBSCRIPTION_STATUSES)[number])
          ? (previousStatus as (typeof SUBSCRIPTION_STATUSES)[number])
          : 'active';

        const { before, after } = await unsuspend(fastify.db, fastify.redis, request.params.id, targetStatus);
        const plan = await getPlanById(fastify.db, after.planId);
        if (!plan) throw AppErrors.internal('Plan not found for subscription.');

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'subscription.unsuspend',
          targetType: 'subscription',
          targetId: after.id,
          reason: request.body.reason,
          metadata: { restoredStatus: targetStatus },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'subscription.unsuspend',
          entityType: 'subscription',
          entityId: after.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toSubscriptionDto(after, plan);
      },
    );

    app.post(
      '/api/v1/admin/subscriptions/:id/cancel',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        schema: {
          tags: ['admin-subscriptions'],
          summary: 'Cancel a subscription (at period end, or immediately).',
          params: idParams,
          body: adminCancelSubscriptionRequestSchema,
          response: { 200: subscriptionDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { before, after } = await cancelByAdmin(fastify.db, fastify.redis, request.params.id, request.body.immediate);
        const plan = await getPlanById(fastify.db, after.planId);
        if (!plan) throw AppErrors.internal('Plan not found for subscription.');

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'subscription.cancel',
          targetType: 'subscription',
          targetId: after.id,
          reason: request.body.reason,
          metadata: { immediate: request.body.immediate },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'subscription.cancel',
          entityType: 'subscription',
          entityId: after.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toSubscriptionDto(after, plan);
      },
    );

    app.post(
      '/api/v1/admin/licenses/:id/device-limit',
      {
        onRequest: [fastify.requirePermission('subscriptions.write')],
        schema: {
          tags: ['admin-subscriptions'],
          summary: "Override one license's device limit (does not touch its plan/subscription).",
          params: idParams,
          body: adminDeviceLimitOverrideRequestSchema,
          response: { 200: z.object({ id: z.string().uuid(), maxDevices: z.number().int() }) },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);

        const before = await fastify.db.query.licenses.findFirst({ where: eq(licenses.id, request.params.id) });
        if (!before || before.deletedAt) throw AppErrors.notFound('license');

        const [after] = await fastify.db
          .update(licenses)
          .set({ maxDevices: request.body.maxDevices })
          .where(eq(licenses.id, request.params.id))
          .returning();

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'license.device_limit_override',
          targetType: 'license',
          targetId: after!.id,
          reason: request.body.reason,
          metadata: { previousMaxDevices: before.maxDevices, newMaxDevices: request.body.maxDevices },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'license.device_limit_override',
          entityType: 'license',
          entityId: after!.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after!),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return { id: after!.id, maxDevices: after!.maxDevices };
      },
    );
  },
  { name: 'module:admin-subscriptions', dependencies: ['auth', 'db', 'redis'] },
);
