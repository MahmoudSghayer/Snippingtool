// /api/v1/analytics/me/* — authenticated, always scoped to the caller
// (`request.authUser.id`), never another user's data. Admin-wide analytics
// live in modules/admin-analytics. See docs/08-analytics.md for formulas.

import { devices } from '@sl/db';
import { activityAnalyticsResponseSchema, meActivityQuerySchema, meOverviewResponseSchema, meProfitsQuerySchema, profitAnalyticsPointSchema } from '@sl/shared';
import { and, eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { getActivitySeries } from '../../lib/analytics/activity.js';
import { getUserLifetimeProfit, getUserProfitSeries } from '../../lib/analytics/profits.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export default fp(
  async function analyticsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/analytics/me/overview',
      {
        onRequest: [fastify.authenticate],
        schema: { tags: ['analytics'], response: { 200: meOverviewResponseSchema } },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const today = new Date().toISOString().slice(0, 10);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        const [lifetime, last7dPoints, last30dPoints, activeDevices] = await Promise.all([
          getUserLifetimeProfit(fastify.db, userId),
          getUserProfitSeries(fastify.db, userId, { from: sevenDaysAgo, to: today, granularity: 'lifetime' }),
          getUserProfitSeries(fastify.db, userId, { from: thirtyDaysAgo, to: today, granularity: 'lifetime' }),
          fastify.db.query.devices.findMany({ where: and(eq(devices.userId, userId), eq(devices.status, 'active')) }),
        ]);

        const last7d = last7dPoints[0]!;
        const last30d = last30dPoints[0]!;

        return {
          lifetimeNetProfit: lifetime.netProfit,
          lifetimeCoinsTraded: lifetime.coinsSpent + lifetime.coinsEarned,
          lifetimeSnipes: lifetime.snipes,
          lifetimeSuccesses: lifetime.successes,
          last7d: { netProfit: last7d.netProfit, snipes: last7d.snipes, successes: last7d.successes },
          last30d: { netProfit: last30d.netProfit, snipes: last30d.snipes, successes: last30d.successes },
          activeDevices: activeDevices.length,
          snipeSuccessRateLifetime: lifetime.snipes > 0 ? lifetime.successes / lifetime.snipes : 0,
        };
      },
    );

    app.get(
      '/api/v1/analytics/me/profits',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['analytics'],
          querystring: meProfitsQuerySchema,
          response: { 200: z.object({ granularity: z.enum(['day', 'week', 'month', 'lifetime']), items: z.array(profitAnalyticsPointSchema) }) },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const { from, to, granularity } = request.query;
        const items = await getUserProfitSeries(fastify.db, userId, { from, to, granularity });
        return { granularity, items };
      },
    );

    app.get(
      '/api/v1/analytics/me/activity',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['analytics'],
          querystring: meActivityQuerySchema,
          response: { 200: activityAnalyticsResponseSchema },
        },
      },
      async (request) => {
        const userId = request.authUser!.id;
        const { from, to, granularity } = request.query;
        const items = await getActivitySeries(fastify.db, { from, to, granularity, userId });
        return { granularity, items };
      },
    );
  },
  { name: 'module:analytics', dependencies: ['auth', 'db'] },
);
