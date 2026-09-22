import { z } from 'zod';

/**
 * Market intelligence surface (docs/14-ml-suggestions.md Phase B): what is
 * moving, what is being traded, and the observed price history behind both.
 *
 * Phase B answers those from **observed listings** — `sniping_activity`'s
 * `listed_price`, which the extension already reports — rather than from any
 * model. Everything here is aggregation over data we actually hold; there is
 * deliberately no prediction in this file.
 */

/** Rolling window for an aggregate. Kept to a small closed set rather than
 * arbitrary ranges so every window has an equal-length previous period to
 * compare against, which is what makes `movers` meaningful. */
export const marketWindowSchema = z.enum(['1h', '24h', '7d', '30d']);
export type MarketWindow = z.infer<typeof marketWindowSchema>;

export const MARKET_WINDOW_HOURS: Record<MarketWindow, number> = {
  '1h': 1,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

/**
 * Whose observations an aggregate is computed from.
 *
 * `mine` is the caller's own activity — always available, since showing
 * somebody their own data back to them reveals nothing they did not supply.
 *
 * `market` is the pooled cross-user view, and is subject to the minimum
 * contributor threshold (docs/14 §12): a slice thin enough to be traceable
 * to one contributor is withheld rather than shown, because an observation
 * on an obscure card at an odd hour identifies whoever was searching for it.
 */
export const marketScopeSchema = z.enum(['mine', 'market']);
export type MarketScope = z.infer<typeof marketScopeSchema>;

export const marketQuerySchema = z
  .object({
    window: marketWindowSchema.default('24h'),
    scope: marketScopeSchema.default('mine'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type MarketQuery = z.infer<typeof marketQuerySchema>;

/** One row of "what is being traded". */
export const marketActivityRowSchema = z.object({
  resourceId: z.string(),
  /** Null until a card record exists for this resource id — Phase A's
   * `cards` table is populated by collectors, and first-party observations
   * can arrive for a card no collector has described yet. */
  name: z.string().nullable(),
  rating: z.number().int().nullable(),

  /** Attempts seen in the window — the liquidity/interest proxy. */
  attempts: z.number().int(),
  successes: z.number().int(),
  /** successes / attempts, or null when there were no attempts. A low rate
   * on high volume is a contested card; a high rate is an easy one. */
  successRate: z.number().nullable(),

  /** Observed listed prices in the window. Null when every attempt in the
   * window recorded no listed price. */
  medianListedPrice: z.number().int().nullable(),
  minListedPrice: z.number().int().nullable(),
  maxListedPrice: z.number().int().nullable(),

  lastSeenAt: z.string().datetime(),
});
export type MarketActivityRow = z.infer<typeof marketActivityRowSchema>;

/** One row of "what moved", comparing a window against the one before it. */
export const marketMoverRowSchema = z.object({
  resourceId: z.string(),
  name: z.string().nullable(),
  rating: z.number().int().nullable(),

  currentMedian: z.number().int(),
  previousMedian: z.number().int(),
  /** Signed percentage change, current vs previous window. */
  changePct: z.number(),

  currentSamples: z.number().int(),
  previousSamples: z.number().int(),
});
export type MarketMoverRow = z.infer<typeof marketMoverRowSchema>;

/**
 * Wrapper carrying why a result might be empty.
 *
 * An empty market list is ambiguous — no trading, no contributors, or a
 * threshold suppression all look identical — and "the market is quiet" is
 * exactly the reading a silently broken pipeline would invite
 * (docs/14 §14). So the reason travels with the data.
 */
export const marketResultMetaSchema = z.object({
  scope: marketScopeSchema,
  window: marketWindowSchema,
  /** Distinct contributors behind a pooled result. Null for `mine`. */
  contributors: z.number().int().nullable(),
  /** True when rows were withheld for being traceable to too few people. */
  suppressedForPrivacy: z.boolean(),
  /** Human-readable explanation when there is nothing to show. */
  emptyReason: z.string().nullable(),
});
export type MarketResultMeta = z.infer<typeof marketResultMetaSchema>;

export const marketActivityResponseSchema = z.object({
  meta: marketResultMetaSchema,
  rows: z.array(marketActivityRowSchema),
});
export type MarketActivityResponse = z.infer<typeof marketActivityResponseSchema>;

export const marketMoversResponseSchema = z.object({
  meta: marketResultMetaSchema,
  rows: z.array(marketMoverRowSchema),
});
export type MarketMoversResponse = z.infer<typeof marketMoversResponseSchema>;

/** A point on a card's observed price history. */
export const marketPricePointSchema = z.object({
  bucket: z.string().datetime(),
  medianListedPrice: z.number().int(),
  samples: z.number().int(),
});
export type MarketPricePoint = z.infer<typeof marketPricePointSchema>;

export const marketCardHistoryResponseSchema = z.object({
  meta: marketResultMetaSchema,
  resourceId: z.string(),
  name: z.string().nullable(),
  rating: z.number().int().nullable(),
  points: z.array(marketPricePointSchema),
});
export type MarketCardHistoryResponse = z.infer<typeof marketCardHistoryResponseSchema>;

export const marketCardHistoryQuerySchema = z
  .object({
    window: marketWindowSchema.default('7d'),
    scope: marketScopeSchema.default('mine'),
  })
  .strict();
export type MarketCardHistoryQuery = z.infer<typeof marketCardHistoryQuerySchema>;
