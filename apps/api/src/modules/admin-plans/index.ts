// Admin plan CRUD: create/update/archive, including lifetime plans
// (`is_lifetime`). Every mutation is permission-gated (`plans.write`),
// requires a `reason`, and writes both an `admin_actions` row and an
// `audit_logs` row (before/after) — docs/05-subscriptions.md §8.

import { planCreateRequestSchema, planUpdateRequestSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import {
  recordAdminAction,
  requireAdminUsersRowId,
  toAuditSnapshot,
} from '../admin-subscriptions/admin-action-log.js';

import {
  archivePlan,
  createPlan,
  featuresJsonbToArray,
  listAllPlans,
  updatePlan,
  type PlanRow,
} from './service.js';

import type { FastifyInstance } from 'fastify';

export const autoPrefix = '/api/v1/admin/plans';

/** Deliberately its own schema, not `@sl/shared`'s `planDtoSchema` — that
 * one's `code` is restricted to the five fixed `PLAN_CODES`, but an admin
 * may create a plan with any code (e.g. a one-off lifetime "founders" plan),
 * so this admin-facing DTO widens `code` to a free-form string and adds the
 * admin-only fields (`isActive`, `stripePriceId`, `sortOrder`, timestamps). */
const adminPlanDtoSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  priceCents: z.number().int().min(0),
  currency: z.string(),
  interval: z.string(),
  deviceLimit: z.number().int().min(1),
  features: z.array(z.string()),
  isLifetime: z.boolean(),
  isActive: z.boolean(),
  stripePriceId: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

function toAdminPlanDto(row: PlanRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    priceCents: row.priceCents,
    currency: row.currency,
    interval: row.interval,
    deviceLimit: row.deviceLimit,
    features: featuresJsonbToArray(row.features),
    isLifetime: row.isLifetime,
    isActive: row.isActive,
    stripePriceId: row.stripePriceId,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default fp(
  async function adminPlansModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/admin/plans',
      {
        onRequest: [fastify.requirePermission('plans.write')],
        schema: {
          tags: ['admin-plans'],
          summary: 'List every plan, including inactive/archived ones.',
          response: { 200: z.object({ items: z.array(adminPlanDtoSchema) }) },
        },
      },
      async () => {
        const rows = await listAllPlans(fastify.db);
        return { items: rows.map(toAdminPlanDto) };
      },
    );

    app.post(
      '/api/v1/admin/plans',
      {
        onRequest: [fastify.requirePermission('plans.write')],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['admin-plans'],
          summary: 'Create a plan (including a one-off lifetime plan).',
          body: planCreateRequestSchema,
          response: { 201: adminPlanDtoSchema },
        },
      },
      async (request, reply) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const row = await createPlan(fastify.db, request.body, request.authUser!.id);

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'plan.create',
          targetType: 'plan',
          targetId: row.id,
          reason: request.body.reason,
          metadata: { code: row.code },
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'plan.create',
          entityType: 'plan',
          entityId: row.id,
          before: null,
          after: toAuditSnapshot(row),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return reply.status(201).send(toAdminPlanDto(row));
      },
    );

    app.patch(
      '/api/v1/admin/plans/:id',
      {
        onRequest: [fastify.requirePermission('plans.write')],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['admin-plans'],
          summary: 'Update a plan.',
          params: z.object({ id: z.string().uuid() }),
          body: planUpdateRequestSchema,
          response: { 200: adminPlanDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { before, after } = await updatePlan(
          fastify.db,
          request.params.id,
          request.body,
          request.authUser!.id,
        );

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'plan.update',
          targetType: 'plan',
          targetId: after.id,
          reason: request.body.reason,
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'plan.update',
          entityType: 'plan',
          entityId: after.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toAdminPlanDto(after);
      },
    );

    app.post(
      '/api/v1/admin/plans/:id/archive',
      {
        onRequest: [fastify.requirePermission('plans.write')],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['admin-plans'],
          summary: 'Archive a plan (is_active = false). Never a hard delete.',
          params: z.object({ id: z.string().uuid() }),
          body: z.object({ reason: z.string().min(1).max(1000) }),
          response: { 200: adminPlanDtoSchema },
        },
      },
      async (request) => {
        const adminUserRowId = await requireAdminUsersRowId(fastify.db, request.authUser!.id);
        const { before, after } = await archivePlan(
          fastify.db,
          request.params.id,
          request.authUser!.id,
        );

        await recordAdminAction({
          db: fastify.db,
          adminUserRowId,
          action: 'plan.archive',
          targetType: 'plan',
          targetId: after.id,
          reason: request.body.reason,
        });
        await recordAudit({
          db: fastify.db,
          actor: { type: 'admin', id: request.authUser!.id },
          action: 'plan.archive',
          entityType: 'plan',
          entityId: after.id,
          before: toAuditSnapshot(before),
          after: toAuditSnapshot(after),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return toAdminPlanDto(after);
      },
    );
  },
  { name: 'module:admin-plans', dependencies: ['auth', 'db'] },
);
