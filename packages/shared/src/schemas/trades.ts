import { z } from 'zod';

import { granularitySchema } from './analytics.js';

export const TRADE_STATUSES = ['bought', 'listed', 'sold', 'expired', 'unsold'] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

/** EA's transfer-market tax on every sale, as a fraction of the sale price.
 * The API is the source of truth for profit figures: it applies this rate
 * itself on every sold trade it stores (see `computeTradeProfit`), so a
 * client can never report a tax-free or inflated profit. The extension's
 * own price model (`apps/extension/src/model/prices.ts`) uses the same
 * constant for its pre-purchase margin estimates. */
export const EA_TAX_RATE = 0.05;

export interface TradeProfit {
  /** Tax withheld on the sale, integer coins (rounded half-up). */
  eaTaxCoins: number;
  /** `sellPrice - eaTaxCoins - buyPrice`, integer coins; negative on a loss. */
  netProfit: number;
}

/** The one profit formula every surface shares: what the trader keeps after
 * EA's tax, minus what they paid. Coins are always integers in this repo
 * (repo convention), so the tax is rounded to whole coins and the net is
 * exact integer arithmetic on top of it. */
export function computeTradeProfit(
  buyPrice: number,
  sellPrice: number,
  taxRate: number = EA_TAX_RATE,
): TradeProfit {
  const eaTaxCoins = Math.round(sellPrice * taxRate);
  return { eaTaxCoins, netProfit: sellPrice - eaTaxCoins - buyPrice };
}

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

/** `POST /trades/:id/close` — records the sale of a trade the extension
 * logged as `bought`/`listed`. The extension cannot observe a sale on its
 * own (it only ever sees listings, never the trader's own transfer list —
 * see `docs/06-extension.md`), so the dashboard offers this as the manual
 * step that turns a bought card into a closed, profit-bearing trade. The
 * API computes tax and net profit itself; the caller supplies only the
 * price and, optionally, when it sold (defaults to now). */
export const closeTradeRequestSchema = z
  .object({
    sellPrice: z.number().int().min(0),
    soldAt: z.string().datetime().optional(),
  })
  .strict();
export type CloseTradeRequest = z.infer<typeof closeTradeRequestSchema>;

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
