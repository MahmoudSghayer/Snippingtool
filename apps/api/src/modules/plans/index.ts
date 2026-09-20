// Public plan catalogue. `GET /api/v1/plans` lists every active, non-deleted
// plan (admin-created lifetime plans included) ordered the way the pricing
// page should render them. No auth required — this is marketing-page data.

import { plans } from '@sl/db';
import { planDtoSchema } from '@sl/shared';
import { and, eq, isNull } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import type { FastifyInstance } from 'fastify';

export function toPlanDto(plan: typeof plans.$inferSelect): unknown {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    priceCents: plan.priceCents,
    currency: plan.currency,
    interval: plan.interval,
    deviceLimit: plan.deviceLimit,
    features: Object.entries(plan.features ?? {})
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => key),
    isLifetime: plan.isLifetime,
  };
}

export default fp(
  async function plansModule(fastify: FastifyInstance) {
    fastify.get(
      '/api/v1/plans',
      {
        schema: {
          tags: ['plans'],
          summary: 'List active plans with prices, features and device limits.',
          response: { 200: z.object({ items: z.array(planDtoSchema) }) },
        },
      },
      async () => {
        const rows = await fastify.db.query.plans.findMany({
          where: and(eq(plans.isActive, true), isNull(plans.deletedAt)),
          orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
        });
        return { items: rows.map(toPlanDto) };
      },
    );
  },
  { name: 'module:plans', dependencies: ['db'] },
);
