import { z } from 'zod';

import { MIN_SALE_PRICE } from '../coins.js';

import { granularitySchema } from './analytics.js';
import { coinPriceSchema, MAX_COIN_PRICE, tradeTimestampSchema } from './ingest-bounds.js';
import { paginationQuerySchema } from './pagination.js';
import { timeZoneSchema } from './timezone.js';

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

/** `GET /trades` item: a trade plus the card's name, from `cards` for the
 * current FC title (`null` when the card isn't known there yet; the
 * dashboard then shows `#resourceId`). `rating` falls back to the card's
 * when the extension didn't report one. */
export const tradeListItemSchema = tradeSchema.extend({
  cardName: z.string().nullable(),
});
export type TradeListItem = z.infer<typeof tradeListItemSchema>;

/** Filters shared by `GET /trades`, `/trades/totals` and
 * `/trades/export.csv`. `from`/`to` are inclusive calendar days of the
 * purchase, in `tz` (so "today" means the trader's today). Sorting is on
 * the purchase time only, server-side, because the list is cursor-paged:
 * a client-side sort would only reorder the page on screen. */
export const tradeFilterQuerySchema = z.object({
  status: z.enum(TRADE_STATUSES).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  tz: timeZoneSchema.default('UTC'),
});
export type TradeFilterQuery = z.infer<typeof tradeFilterQuerySchema>;

export const tradeListQuerySchema = paginationQuerySchema.merge(tradeFilterQuerySchema).extend({
  order: z.enum(['desc', 'asc']).default('desc'),
});
export type TradeListQuery = z.infer<typeof tradeListQuerySchema>;

/** `GET /trades/totals`: sums over every trade the filter matches, not just
 * the page on screen. `spent` counts every purchase; `revenue` and
 * `netProfit` count sales only (net is after EA's tax). */
export const tradeTotalsSchema = z.object({
  count: z.number().int().min(0),
  sold: z.number().int().min(0),
  spent: z.number().int().min(0),
  revenue: z.number().int().min(0),
  netProfit: z.number().int(),
});
export type TradeTotals = z.infer<typeof tradeTotalsSchema>;

/** A trade as the extension reports it (`POST /trades/batch`): the read
 * model above plus the ingest bounds (ingest-bounds.ts). Kept separate so
 * the list endpoint can still serialise trades older than the ingest
 * window. A buy costs at least one coin; a sale may be a zero-coin quick
 * sell. */
export const tradeIngestSchema = tradeSchema.extend({
  buyPrice: z.number().int().min(1).max(MAX_COIN_PRICE),
  sellPrice: coinPriceSchema.nullable(),
  boughtAt: tradeTimestampSchema,
  soldAt: tradeTimestampSchema.nullable(),
});

export const reportTradesRequestSchema = z
  .object({
    trades: z.array(tradeIngestSchema).min(1).max(200),
  })
  .strict();
export type ReportTradesRequest = z.infer<typeof reportTradesRequestSchema>;

/** `POST /trades/:id/close` — records the sale of a trade the extension
 * logged as `bought`/`listed`. The extension reports the sales it sees on
 * the trader's own trade pile itself (`/trades/batch`, status `sold`,
 * apps/extension/src/lib/trade-lifecycle.ts); this is the manual step for
 * the rest, e.g. a card sold while the extension was not running. The
 * API computes tax and net profit itself; the caller supplies only the
 * price and, optionally, when it sold (defaults to now). */
export const closeTradeRequestSchema = z
  .object({
    // Unlike an extension report (`coinPriceSchema`, where 0 is a quick
    // sell), a sale recorded by hand is a market sale: EA's lowest Buy Now
    // is 200, and anything under it is a typo such as a dropped `k`.
    sellPrice: z.number().int().min(MIN_SALE_PRICE).max(MAX_COIN_PRICE),
    soldAt: tradeTimestampSchema.optional(),
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
