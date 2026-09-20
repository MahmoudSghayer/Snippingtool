// Analytics DTOs and request schemas shared by apps/api's `analytics` /
// `admin-analytics` modules and the dashboard. Every metric here has its
// exact formula documented in docs/08-analytics.md — this file only
// describes shape, not semantics.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Common range / granularity inputs
// ---------------------------------------------------------------------------

/** `from`/`to` are calendar-day strings (UTC), inclusive on both ends.
 * `granularity` controls series bucketing; `tz` is accepted for forward
 * compatibility (bucket-boundary math is UTC-only today — see
 * docs/08-analytics.md "Timezone handling"). */
export const analyticsRangeQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  granularity: z.enum(['day', 'week', 'month', 'lifetime']).default('day'),
  tz: z.string().min(1).max(64).default('UTC'),
});
export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeQuerySchema>;

export const reportFormatSchema = z.enum(['json', 'csv']);
export type ReportFormat = z.infer<typeof reportFormatSchema>;

export const analyticsReportQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  format: reportFormatSchema.default('json'),
});
export type AnalyticsReportQuery = z.infer<typeof analyticsReportQuerySchema>;

// ---------------------------------------------------------------------------
// KPI overview
// ---------------------------------------------------------------------------

export const kpiOverviewSchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  totalUsers: z.number().int().min(0),
  activeUsers7d: z.number().int().min(0),
  activeUsers30d: z.number().int().min(0),
  onlineUsers: z.number().int().min(0),
  totalRevenueCents: z.number().int().min(0),
  mrrCents: z.number().min(0),
  arrCents: z.number().min(0),
  conversion: z.object({
    cohortSize: z.number().int().min(0),
    converted: z.number().int().min(0),
    rate: z.number().min(0).max(1),
  }),
  churn: z.object({
    activeAtStart: z.number().int().min(0),
    churned: z.number().int().min(0),
    rate: z.number().min(0).max(1),
  }),
  retention: z.array(
    z.object({
      cohortWeek: z.string().date(),
      cohortSize: z.number().int().min(0),
      retainedD7: z.number().int().min(0),
      retainedD30: z.number().int().min(0),
      retentionD7: z.number().min(0).max(1),
      retentionD30: z.number().min(0).max(1),
    }),
  ),
  extensionInstalls: z.object({
    total: z.number().int().min(0),
    byBrowser: z.record(z.number().int().min(0)),
  }),
  versionDistribution: z.record(z.number().int().min(0)),
});
export type KpiOverview = z.infer<typeof kpiOverviewSchema>;

// ---------------------------------------------------------------------------
// Profit analytics
// ---------------------------------------------------------------------------

export const profitAnalyticsPointSchema = z.object({
  bucket: z.string(),
  netProfit: z.number().int(),
  coinsSpent: z.number().int().min(0),
  coinsEarned: z.number().int().min(0),
  coinsTraded: z.number().int().min(0),
  snipes: z.number().int().min(0),
  successes: z.number().int().min(0),
  tradesClosed: z.number().int().min(0),
  activeTraders: z.number().int().min(0),
  snipeSuccessRate: z.number().min(0).max(1),
});
export type ProfitAnalyticsPoint = z.infer<typeof profitAnalyticsPointSchema>;

export const profitAnalyticsResponseSchema = z.object({
  granularity: z.enum(['day', 'week', 'month', 'lifetime']),
  items: z.array(profitAnalyticsPointSchema),
  lifetime: z.object({
    netProfit: z.number().int(),
    coinsTraded: z.number().int().min(0),
    avgProfitPerActiveTrader: z.number(),
  }),
});
export type ProfitAnalyticsResponse = z.infer<typeof profitAnalyticsResponseSchema>;

export const profitLeaderboardQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  order: z.enum(['top', 'least']).default('top'),
});
export type ProfitLeaderboardQuery = z.infer<typeof profitLeaderboardQuerySchema>;

export const profitLeaderboardEntrySchema = z.object({
  rank: z.number().int().min(1),
  userId: z.string().uuid(),
  email: z.string().email(),
  netProfit: z.number().int(),
  coinsTraded: z.number().int().min(0),
  snipes: z.number().int().min(0),
  successes: z.number().int().min(0),
  tradesClosed: z.number().int().min(0),
});
export type ProfitLeaderboardEntry = z.infer<typeof profitLeaderboardEntrySchema>;

export const profitLeaderboardResponseSchema = z.object({
  order: z.enum(['top', 'least']),
  items: z.array(profitLeaderboardEntrySchema),
});
export type ProfitLeaderboardResponse = z.infer<typeof profitLeaderboardResponseSchema>;

// ---------------------------------------------------------------------------
// Activity analytics
// ---------------------------------------------------------------------------

export const activityAnalyticsPointSchema = z.object({
  bucket: z.string(),
  logins: z.number().int().min(0),
  searches: z.number().int().min(0),
  filterChanges: z.number().int().min(0),
  snipeAttempts: z.number().int().min(0),
  snipeSuccesses: z.number().int().min(0),
  errors: z.number().int().min(0),
  activeDevices: z.number().int().min(0),
  activeIps: z.number().int().min(0),
});
export type ActivityAnalyticsPoint = z.infer<typeof activityAnalyticsPointSchema>;

export const activityAnalyticsResponseSchema = z.object({
  granularity: z.enum(['day', 'week', 'month', 'lifetime']),
  items: z.array(activityAnalyticsPointSchema),
});
export type ActivityAnalyticsResponse = z.infer<typeof activityAnalyticsResponseSchema>;

// ---------------------------------------------------------------------------
// Subscription metrics
// ---------------------------------------------------------------------------

export const subscriptionMetricsPointSchema = z.object({
  bucket: z.string(),
  newSubscriptions: z.number().int().min(0),
  canceledSubscriptions: z.number().int().min(0),
  trialStarts: z.number().int().min(0),
  trialConversions: z.number().int().min(0),
  couponRedemptions: z.number().int().min(0),
});
export type SubscriptionMetricsPoint = z.infer<typeof subscriptionMetricsPointSchema>;

export const subscriptionMetricsResponseSchema = z.object({
  granularity: z.enum(['day', 'week', 'month', 'lifetime']),
  items: z.array(subscriptionMetricsPointSchema),
  planMix: z.record(z.number().int().min(0)),
  pastDueCount: z.number().int().min(0),
});
export type SubscriptionMetricsResponse = z.infer<typeof subscriptionMetricsResponseSchema>;

// ---------------------------------------------------------------------------
// Feature usage / extension usage / errors / performance
// ---------------------------------------------------------------------------

export const featureUsageResponseSchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  byFeature: z.record(z.number().int().min(0)),
});
export type FeatureUsageResponse = z.infer<typeof featureUsageResponseSchema>;

export const extensionUsageResponseSchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  heartbeats: z.number().int().min(0),
  activeInstalls: z.number().int().min(0),
  byVersion: z.record(z.number().int().min(0)),
  byBrowser: z.record(z.number().int().min(0)),
});
export type ExtensionUsageResponse = z.infer<typeof extensionUsageResponseSchema>;

export const errorRatesResponseSchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  extensionErrorsInRange: z.number().int().min(0),
  apiServerErrorsLast5Min: z.number().int().min(0),
});
export type ErrorRatesResponse = z.infer<typeof errorRatesResponseSchema>;

export const performanceResponseSchema = z.object({
  sampleCount: z.number().int().min(0),
  p50Ms: z.number().min(0).nullable(),
  p95Ms: z.number().min(0).nullable(),
  p99Ms: z.number().min(0).nullable(),
});
export type PerformanceResponse = z.infer<typeof performanceResponseSchema>;

// ---------------------------------------------------------------------------
// User-facing (/api/v1/analytics/me/*)
// ---------------------------------------------------------------------------

export const meOverviewResponseSchema = z.object({
  lifetimeNetProfit: z.number().int(),
  lifetimeCoinsTraded: z.number().int().min(0),
  lifetimeSnipes: z.number().int().min(0),
  lifetimeSuccesses: z.number().int().min(0),
  last7d: z.object({ netProfit: z.number().int(), snipes: z.number().int().min(0), successes: z.number().int().min(0) }),
  last30d: z.object({ netProfit: z.number().int(), snipes: z.number().int().min(0), successes: z.number().int().min(0) }),
  activeDevices: z.number().int().min(0),
  snipeSuccessRateLifetime: z.number().min(0).max(1),
});
export type MeOverviewResponse = z.infer<typeof meOverviewResponseSchema>;

export const meProfitsQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  granularity: z.enum(['day', 'week', 'month', 'lifetime']).default('day'),
});
export type MeProfitsQuery = z.infer<typeof meProfitsQuerySchema>;

export const meActivityQuerySchema = analyticsRangeQuerySchema;
export type MeActivityQuery = AnalyticsRangeQuery;
