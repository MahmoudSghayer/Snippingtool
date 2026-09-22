import { z } from 'zod';

import { granularitySchema } from './analytics.js';

export const TRADE_STATUSES = ['bought', 'listed', 'sold', 'expired', 'unsold'] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

/** One completed (or in-flight) trade, computed client-side by the
 * extension's own price model and reported so the dashboard can show
 * session/lifetime P&L. */
export const tradeSchema = z
  .object({
    id: z.string().uuid(),
    tradeId: z.string().min(1).max(64),
    resourceId: z.number().int().positive(),
    assetId: z.number().int().positive().nullable(),
    rating: z.number().int().min(0).max(99).nullable(),
    buyPrice: z.number().int().min(0),
    sellPrice: z.number().int().min(0).nullable(),
    eaTax: z.number().min(0).max(1),
    netProfit: z.number().int().nullable(),
    status: z.enum(TRADE_STATUSES),
    boughtAt: z.string().datetime(),
    soldAt: z.string().datetime().nullable(),
  })
  .strict();
export type Trade = z.infer<typeof tradeSchema>;

export const reportTradesRequestSchema = z
  .object({
    trades: z.array(tradeSchema).min(1).max(200),
  })
  .strict();
export type ReportTradesRequest = z.infer<typeof reportTradesRequestSchema>;

/** Daily rollup, `profits` table — `apps/api`'s `profits.rollup` job
 * (hourly) computes this from `trades` and `sniping_activity`; the dashboard
 * reads it directly rather than aggregating trades on every request. */
export const dailyProfitSchema = z.object({
  day: z.string().date(),
  coinsSpent: z.number().int().min(0),
  coinsEarned: z.number().int().min(0),
  netProfit: z.number().int(),
  snipes: z.number().int().min(0),
  successes: z.number().int().min(0),
  tradesClosed: z.number().int().min(0),
});
export type DailyProfit = z.infer<typeof dailyProfitSchema>;

/** Defect #6 fix (docs/12-testing.md "Defects found"): this used to be its
 * own `'daily'|'weekly'|'monthly'|'lifetime'` enum, out of step with
 * `/admin/analytics/*` and `/analytics/me/*`'s `'day'|'week'|'month'|
 * 'lifetime'`. Now shares `granularitySchema` (schemas/analytics.ts), which
 * still accepts the legacy `'daily'/'weekly'/'monthly'` strings on input
 * (deprecated, normalised at parse time) so an existing `/profits` caller
 * using the old vocabulary keeps working. */
export const profitQuerySchema = z
  .object({
    from: z.string().date(),
    to: z.string().date(),
    granularity: granularitySchema.default('day'),
  })
  .strict();
export type ProfitQuery = z.infer<typeof profitQuerySchema>;
