import { z } from 'zod';

import { MIN_SALE_PRICE } from '../coins.js';

import { granularitySchema } from './analytics.js';
import { coinPriceSchema, MAX_COIN_PRICE, tradeTimestampSchema } from './ingest-bounds.js';
import { paginationQuerySchema } from './pagination.js';
import { timeZoneSchema } from './timezone.js';

export const TRADE_STATUSES = ['bought', 'listed', 'sold', 'expired', 'unsold'] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

/** How a sold trade's price is known (`trades.sale_source`, migration
 * 0040):
 * - `observed`: the extension saw the listing sold on the trade pile.
 * - `inferred`: an estimate. A listed card left the trade pile without its
 *   sale being seen, and EA lets nobody remove a card while its listing is
 *   live, so it sold, at its buy-now price (apps/extension/src/lib/
 *   trade-lifecycle.ts).
 * - `manual`: the trader recorded it on the dashboard.
 * `null` while a trade is unsold, and for sales stored before 0040. */
export const SALE_SOURCES = ['observed', 'inferred', 'manual'] as const;
export type SaleSource = (typeof SALE_SOURCES)[number];
/** What the extension may claim for a sale it reports: never `manual`. */
export const REPORTED_SALE_SOURCES = ['observed', 'inferred'] as const;

/** EA's id for the card itself (`itemData.id`): unlike the listing's
 * `tradeId` it survives the purchase and every relist, so it links a sale
 * to its buy (the extension's trade lifecycle keys on it). Bounded like
 * `tradeId`. */
export const tradeItemIdSchema = z.string().min(1).max(64);

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
    id: z.string().guid(),
    tradeId: z.string().min(1).max(64),
    /** The card's own id, on the buy report and on the sale report. Absent
     * from reports by older extensions, and when the bought listing carried
     * none. */
    itemId: tradeItemIdSchema.optional(),
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
    /** See `SALE_SOURCES`. The API's trades carry it (null when unsold or
     * stored before it existed); a report leaves it out for an observed
     * sale. */
    saleSource: z.enum(SALE_SOURCES).nullable().optional(),
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
  // A sold report is `observed` unless it says `inferred`; only the
  // dashboard records a `manual` sale.
  saleSource: z.enum(REPORTED_SALE_SOURCES).optional(),
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

/** Most trades `POST /trades/mark-sold` takes at once. */
export const MARK_SOLD_MAX_TRADES = 100;

/** `POST /trades/mark-sold` — the dashboard's bulk "Mark as sold": several
 * of the caller's `bought` trades of one card, sold at one price. Same
 * price rules as `/close`; `soldAt` defaults to now. */
export const markTradesSoldRequestSchema = z
  .object({
    ids: z.array(z.string().guid()).min(1).max(MARK_SOLD_MAX_TRADES),
    sellPrice: z.number().int().min(MIN_SALE_PRICE).max(MAX_COIN_PRICE),
    soldAt: tradeTimestampSchema.optional(),
  })
  .strict();
export type MarkTradesSoldRequest = z.infer<typeof markTradesSoldRequestSchema>;

/** Why a requested trade was left as it was: not one of the caller's
 * trades (or no such trade), no longer `bought` (sold meanwhile, say), or
 * bought after the given sale time. */
export const MARK_SOLD_SKIP_REASONS = ['not_found', 'not_bought', 'sold_before_bought'] as const;
export type MarkSoldSkipReason = (typeof MARK_SOLD_SKIP_REASONS)[number];

export const markTradesSoldResponseSchema = z.object({
  updated: z.array(tradeSchema),
  skipped: z.array(z.object({ id: z.string().guid(), reason: z.enum(MARK_SOLD_SKIP_REASONS) })),
});
export type MarkTradesSoldResponse = z.infer<typeof markTradesSoldResponseSchema>;

/** How many of the trader's latest sales of a card
 * `GET /trades/sell-price` averages. */
export const SELL_PRICE_SAMPLE = 20;

/** `GET /trades/sell-price?resourceId=` — the bulk dialog's default price. */
export const tradeSellPriceQuerySchema = z
  .object({ resourceId: z.coerce.number().int().positive() })
  .strict();
export type TradeSellPriceQuery = z.infer<typeof tradeSellPriceQuerySchema>;

/** The caller's average sell price over their latest `SELL_PRICE_SAMPLE`
 * sales of the card (at least `MIN_SALE_PRICE` each: a quick sell is not a
 * market price), whole coins; `null` with no such sale. */
export const tradeSellPriceSchema = z.object({
  resourceId: z.number().int().positive(),
  averageSellPrice: z.number().int().nullable(),
  sales: z.number().int().min(0),
});
export type TradeSellPrice = z.infer<typeof tradeSellPriceSchema>;

/** How far back `GET /extension/open-trades` looks, and the most trades it
 * returns (the newest). */
export const OPEN_TRADES_WINDOW_DAYS = 30;
export const OPEN_TRADES_MAX = 300;

/** One of the caller's trades still `bought` that carries an item id: what
 * a browser needs to follow the card (apps/extension/src/lib/
 * trade-lifecycle.ts) and report its sale on this same `tradeId`, whichever
 * browser bought it. */
export const openTradeSchema = z
  .object({
    tradeId: z.string().min(1).max(64),
    itemId: tradeItemIdSchema,
    resourceId: z.number().int().positive(),
    rating: z.number().int().min(0).max(99).nullable(),
    buyPrice: z.number().int().min(1).max(MAX_COIN_PRICE),
    boughtAt: z.string().datetime(),
  })
  .strict();
export type OpenTrade = z.infer<typeof openTradeSchema>;

/** `GET /extension/open-trades`: the caller's `bought` trades with an item
 * id, bought in the last `OPEN_TRADES_WINDOW_DAYS` days, newest first, at
 * most `OPEN_TRADES_MAX`. `truncated`: more matched than were returned. */
export const openTradesResponseSchema = z
  .object({
    items: z.array(openTradeSchema).max(OPEN_TRADES_MAX),
    truncated: z.boolean(),
  })
  .strict();
export type OpenTradesResponse = z.infer<typeof openTradesResponseSchema>;

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
