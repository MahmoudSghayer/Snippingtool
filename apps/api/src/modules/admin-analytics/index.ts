// /api/v1/admin/analytics/* — platform-wide KPI, profit, activity,
// subscription, feature/extension usage, error-rate and performance
// analytics, plus streamed CSV/JSON reports. Every route requires the
// `analytics.read` permission. See docs/08-analytics.md for every metric's
// formula and the endpoint table.

import {
  activityAnalyticsResponseSchema,
  analyticsRangeQuerySchema,
  analyticsReportQuerySchema,
  errorRatesResponseSchema,
  extensionUsageResponseSchema,
  featureUsageResponseSchema,
  kpiOverviewSchema,
  performanceResponseSchema,
  profitAnalyticsResponseSchema,
  profitLeaderboardQuerySchema,
  profitLeaderboardResponseSchema,
  subscriptionMetricsResponseSchema,
} from '@sl/shared';
import fp from 'fastify-plugin';

import { getActivitySeries } from '../../lib/analytics/activity.js';
import { csvStream } from '../../lib/analytics/csv.js';
import { getErrorRates } from '../../lib/analytics/errors.js';
import { getExtensionUsage } from '../../lib/analytics/extension.js';
import { getFeatureUsage } from '../../lib/analytics/features.js';
import { getKpiOverview } from '../../lib/analytics/kpi.js';
import { getPerformance } from '../../lib/analytics/performance.js';
import { getPlatformLifetimeSummary, getPlatformProfitSeries, getProfitLeaderboard } from '../../lib/analytics/profits.js';
import { getPastDueCount, getPlanMix, getSubscriptionSeries } from '../../lib/analytics/subscriptions.js';
import { recordAudit } from '../../lib/audit.js';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export default fp(
  async function adminAnalyticsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const gate = fastify.requirePermission('analytics.read');

    app.get(
      '/api/v1/admin/analytics/overview',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsRangeQuerySchema, response: { 200: kpiOverviewSchema } } },
      async (request) => {
        const { from, to } = request.query;
        return getKpiOverview(fastify.db, fastify.redis, { from, to });
      },
    );

    app.get(
      '/api/v1/admin/analytics/profits',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsRangeQuerySchema, response: { 200: profitAnalyticsResponseSchema } } },
      async (request) => {
        const { from, to, granularity } = request.query;
        const [items, lifetime] = await Promise.all([
          getPlatformProfitSeries(fastify.db, { from, to, granularity }),
          getPlatformLifetimeSummary(fastify.db, { from, to }),
        ]);
        return { granularity, items, lifetime };
      },
    );

    app.get(
      '/api/v1/admin/analytics/profits/leaderboard',
      {
        onRequest: [gate],
        schema: { tags: ['admin-analytics'], querystring: profitLeaderboardQuerySchema, response: { 200: profitLeaderboardResponseSchema } },
      },
      async (request) => {
        const { from, to, limit, order } = request.query;
        const items = await getProfitLeaderboard(fastify.db, { from, to, limit, order });
        return { order, items };
      },
    );

    app.get(
      '/api/v1/admin/analytics/activity',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsRangeQuerySchema, response: { 200: activityAnalyticsResponseSchema } } },
      async (request) => {
        const { from, to, granularity } = request.query;
        const items = await getActivitySeries(fastify.db, { from, to, granularity });
        return { granularity, items };
      },
    );

    app.get(
      '/api/v1/admin/analytics/subscriptions',
      {
        onRequest: [gate],
        schema: { tags: ['admin-analytics'], querystring: analyticsRangeQuerySchema, response: { 200: subscriptionMetricsResponseSchema } },
      },
      async (request) => {
        const { from, to, granularity } = request.query;
        const [items, planMix, pastDueCount] = await Promise.all([
          getSubscriptionSeries(fastify.db, { from, to, granularity }),
          getPlanMix(fastify.db),
          getPastDueCount(fastify.db),
        ]);
        return { granularity, items, planMix, pastDueCount };
      },
    );

    app.get(
      '/api/v1/admin/analytics/feature-usage',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsRangeQuerySchema, response: { 200: featureUsageResponseSchema } } },
      async (request) => {
        const { from, to } = request.query;
        const byFeature = await getFeatureUsage(fastify.db, { from, to });
        return { from, to, byFeature };
      },
    );

    app.get(
      '/api/v1/admin/analytics/extension',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsRangeQuerySchema, response: { 200: extensionUsageResponseSchema } } },
      async (request) => {
        const { from, to } = request.query;
        const usage = await getExtensionUsage(fastify.db, { from, to });
        return { from, to, ...usage };
      },
    );

    app.get(
      '/api/v1/admin/analytics/errors',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsRangeQuerySchema, response: { 200: errorRatesResponseSchema } } },
      async (request) => {
        const { from, to } = request.query;
        const rates = await getErrorRates(fastify.db, fastify.redis, { from, to });
        return { from, to, ...rates };
      },
    );

    app.get(
      '/api/v1/admin/analytics/performance',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], response: { 200: performanceResponseSchema } } },
      async () => getPerformance(fastify.metrics.registry),
    );

    // -----------------------------------------------------------------
    // Reports: streamed CSV or buffered JSON over a date range, each
    // recording an `analytics.export` audit row before streaming starts.
    // -----------------------------------------------------------------

    app.get(
      '/api/v1/admin/analytics/reports/kpi',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsReportQuerySchema } },
      async (request, reply) => {
        const { from, to, format } = request.query;
        const overview = await getKpiOverview(fastify.db, fastify.redis, { from, to });
        await auditExport(fastify, request, 'kpi', from, to, format);

        const row = {
          from: overview.from,
          to: overview.to,
          totalUsers: overview.totalUsers,
          activeUsers7d: overview.activeUsers7d,
          activeUsers30d: overview.activeUsers30d,
          totalRevenueCents: overview.totalRevenueCents,
          mrrCents: overview.mrrCents,
          arrCents: overview.arrCents,
          conversionRate: overview.conversion.rate,
          churnRate: overview.churn.rate,
          extensionInstallsTotal: overview.extensionInstalls.total,
        };

        if (format === 'json') return { items: [row] };

        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', `attachment; filename="kpi-report-${from}-to-${to}.csv"`);
        return reply.send(
          csvStream(
            [
              { key: 'from', header: 'from' },
              { key: 'to', header: 'to' },
              { key: 'totalUsers', header: 'total_users' },
              { key: 'activeUsers7d', header: 'active_users_7d' },
              { key: 'activeUsers30d', header: 'active_users_30d' },
              { key: 'totalRevenueCents', header: 'total_revenue_cents' },
              { key: 'mrrCents', header: 'mrr_cents' },
              { key: 'arrCents', header: 'arr_cents' },
              { key: 'conversionRate', header: 'conversion_rate' },
              { key: 'churnRate', header: 'churn_rate' },
              { key: 'extensionInstallsTotal', header: 'extension_installs_total' },
            ],
            [row],
          ),
        );
      },
    );

    app.get(
      '/api/v1/admin/analytics/reports/profits',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsReportQuerySchema } },
      async (request, reply) => {
        const { from, to, format } = request.query;
        const items = await getPlatformProfitSeries(fastify.db, { from, to, granularity: 'day' });
        await auditExport(fastify, request, 'profits', from, to, format);

        if (format === 'json') return { items };

        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', `attachment; filename="profits-report-${from}-to-${to}.csv"`);
        return reply.send(
          csvStream(
            [
              { key: 'bucket', header: 'day' },
              { key: 'netProfit', header: 'net_profit' },
              { key: 'coinsSpent', header: 'coins_spent' },
              { key: 'coinsEarned', header: 'coins_earned' },
              { key: 'coinsTraded', header: 'coins_traded' },
              { key: 'snipes', header: 'snipes' },
              { key: 'successes', header: 'successes' },
              { key: 'tradesClosed', header: 'trades_closed' },
              { key: 'activeTraders', header: 'active_traders' },
              { key: 'snipeSuccessRate', header: 'snipe_success_rate' },
            ],
            items,
          ),
        );
      },
    );

    app.get(
      '/api/v1/admin/analytics/reports/activity',
      { onRequest: [gate], schema: { tags: ['admin-analytics'], querystring: analyticsReportQuerySchema } },
      async (request, reply) => {
        const { from, to, format } = request.query;
        const items = await getActivitySeries(fastify.db, { from, to, granularity: 'day' });
        await auditExport(fastify, request, 'activity', from, to, format);

        if (format === 'json') return { items };

        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', `attachment; filename="activity-report-${from}-to-${to}.csv"`);
        return reply.send(
          csvStream(
            [
              { key: 'bucket', header: 'day' },
              { key: 'logins', header: 'logins' },
              { key: 'searches', header: 'searches' },
              { key: 'filterChanges', header: 'filter_changes' },
              { key: 'snipeAttempts', header: 'snipe_attempts' },
              { key: 'snipeSuccesses', header: 'snipe_successes' },
              { key: 'errors', header: 'errors' },
              { key: 'activeDevices', header: 'active_devices' },
              { key: 'activeIps', header: 'active_ips' },
            ],
            items,
          ),
        );
      },
    );
  },
  { name: 'module:admin-analytics', dependencies: ['auth', 'db', 'redis', 'metrics'] },
);

async function auditExport(
  fastify: FastifyInstance,
  request: { authUser?: { id: string }; ip: string; headers: Record<string, unknown>; id: string },
  report: string,
  from: string,
  to: string,
  format: string,
): Promise<void> {
  await recordAudit({
    db: fastify.db,
    actor: { type: 'admin', id: request.authUser!.id },
    action: 'analytics.export',
    entityType: 'analytics_report',
    entityId: null,
    before: null,
    after: { report, from, to, format },
    ip: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    requestId: request.id,
  });
}
