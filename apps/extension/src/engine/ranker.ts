/*
 * ranker.ts — the opportunity ranker (M2/M3).
 *
 * Two separable jobs, both "simple statistics, no ML" per the price model's
 * own rule (docs/01-architecture.md, project instruction 7):
 *
 *   1. Score a single candidate snipe: expected value per attempt =
 *      (predicted sale price x (1 - EA's 5% tax) - snipe price) x P(sell in
 *      the window) — the same net-of-tax math `model/prices.ts`'s `margin()`
 *      already does, made explicit here as the ranker's own EV so
 *      `rankCandidates` has one thing to sort by.
 *   2. Score a *filter* by its realised coins/hour, so `content/index.ts`
 *      can rotate active filters toward what is actually paying and retire
 *      ones that have gone flat — this is what makes M2 "assist" more than a
 *      keyboard shortcut: the panel's ranker view (docs/06-extension.md)
 *      shows this directly.
 *
 * Nothing here calls `adapter.act()` or `governor.allow()` — the ranker only
 * ever *proposes*; `engine/assist.ts`/`engine/autobuyer.ts` are the only
 * things that turn a ranked candidate into an action, and only through the
 * governor (docs/01-architecture.md, §3.4).
 */
import { EA_TAX, type PriceSummary } from '../model/prices.js';

import type { FilterStats, SavedFilter } from '@sl/shared';


// ---- 1. Opportunity scoring -------------------------------------------------

export interface OpportunityCandidate {
  resourceId: number;
  tradeId: string;
  /** The buy-now / snipe price under consideration — what `adapter.act('buy',
   * tradeId, price)` would be called with if this candidate is taken. */
  price: number;
  summary: PriceSummary;
}

export interface ScoredOpportunity extends OpportunityCandidate {
  /** Expected value in coins: `netAtMedian * P(sell)`, rounded. */
  ev: number;
  netAtMedian: number | null;
  probabilityOfSale: number | null;
}

/** When `summary.sellThrough` is `null` (fewer than 5 decided auctions —
 * see `model/prices.ts`), we have no observed sell-through yet. Scoring the
 * candidate as unsellable (`P = 0`) would starve every new/thin card of a
 * chance ever to accumulate data; scoring it as certain (`P = 1`) would let
 * the ranker chase unproven cards ahead of proven ones. A conservative 0.5
 * prior sits between both failure modes and is cheap to reason about. */
export const DEFAULT_SELL_PROBABILITY = 0.5;

/** EV per attempt = (predicted sale x (1 - tax) - price) x P(sell). Returns
 * `ev: -Infinity` for a candidate the price model can't yet judge (no
 * median), so it sorts last and `rankCandidates`'s `minEv` filter drops it
 * without a special case. */
export function scoreOpportunity(
  summary: PriceSummary,
  price: number,
): { ev: number; netAtMedian: number | null; probabilityOfSale: number | null } {
  if (summary.median == null || !Number.isFinite(price) || price <= 0) {
    return { ev: -Infinity, netAtMedian: null, probabilityOfSale: null };
  }
  const netAtMedian = Math.round(summary.median * (1 - EA_TAX)) - price;
  const probabilityOfSale = summary.sellThrough ?? DEFAULT_SELL_PROBABILITY;
  const ev = Math.round(netAtMedian * probabilityOfSale);
  return { ev, netAtMedian, probabilityOfSale };
}

export interface RankOptions {
  /** Drop anything scoring below this EV. Defaults to 0 (break-even or
   * better) — the caller (assist/autobuyer) applies the user's
   * `minProfitPerSnipe` target on top of this. */
  minEv?: number;
}

/** Highest EV first. Ties broken by lower price (cheaper capital tied up for
 * the same expected return). */
export function rankCandidates(candidates: OpportunityCandidate[], opts: RankOptions = {}): ScoredOpportunity[] {
  const minEv = opts.minEv ?? 0;
  return candidates
    .map((c) => ({ ...c, ...scoreOpportunity(c.summary, c.price) }))
    .filter((c) => c.ev >= minEv)
    .sort((a, b) => (b.ev !== a.ev ? b.ev - a.ev : a.price - b.price));
}

// ---- 2. Filter scoring, rotation and retirement -----------------------------

export interface FilterScore {
  filterId: string;
  /** Decay-weighted average of `coinsPerHour` across the filter's reported
   * windows — recent windows count for more, so a filter that used to pay
   * and has since gone quiet scores low without needing its whole history
   * discarded. */
  score: number;
  /** Number of reported windows this score is built from (not raw search
   * count) — the sample size that gates retirement below. */
  windowCount: number;
  /** True once a filter has enough history to judge and that history is
   * flat (near-zero realised return) — a rotation candidate for retirement. */
  isFlat: boolean;
}

export const DEFAULT_HALF_LIFE_HOURS = 24;
/** Below this many coins/hour, a filter isn't worth the rotation slot. */
export const FLAT_SCORE_THRESHOLD_COINS_PER_HOUR = 50;
/** Windows of history required before a filter can be judged flat — avoids
 * retiring a filter on one unlucky hour. */
export const MIN_WINDOWS_FOR_RETIREMENT = 5;

/** Exponential decay over a filter's `filter_stats` windows
 * (packages/shared/src/schemas/filters.ts). `halfLifeHours` is how long ago
 * a window's weight in the average halves — 24h by default, so yesterday's
 * results still count but this morning's count more. */
export function scoreFilterHistory(
  history: FilterStats[],
  opts: { halfLifeHours?: number; now?: number } = {},
): FilterScore {
  const filterId = history[0]?.filterId ?? '';
  if (history.length === 0) {
    return { filterId, score: 0, windowCount: 0, isFlat: false };
  }

  const halfLifeHours = opts.halfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
  const now = opts.now ?? Date.now();
  const decayLambda = Math.LN2 / (halfLifeHours * 3_600_000);

  let weightedSum = 0;
  let weightTotal = 0;
  for (const window of history) {
    const ageMs = Math.max(0, now - new Date(window.windowStart).getTime());
    const weight = Math.exp(-decayLambda * ageMs);
    weightedSum += weight * window.coinsPerHour;
    weightTotal += weight;
  }
  const score = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const isFlat = history.length >= MIN_WINDOWS_FOR_RETIREMENT && Math.abs(score) < FLAT_SCORE_THRESHOLD_COINS_PER_HOUR;

  return { filterId, score, windowCount: history.length, isFlat };
}

export interface RotationResult {
  /** Filter ids that should be actively searched, ranked highest score
   * first, capped at `maxActive`. */
  active: string[];
  /** Filter ids that have enough history to be judged flat and should be
   * deactivated (`saved_filters.is_active = false`, reported as a
   * `filter_change` activity event with `action: 'deactivated'`). */
  retired: string[];
}

export interface RotateOptions {
  maxActive?: number;
}

/** Rotation and retirement of flat filters (docs/01-architecture.md,
 * `engine/ranker.ts`). A filter with no score yet (brand new, no reported
 * windows) is treated as score 0 but *not* flat — it has not had the
 * `MIN_WINDOWS_FOR_RETIREMENT` chance to prove itself yet, so it stays in
 * the rotation pool rather than being retired on day one. */
export function rotateFilters(
  filters: SavedFilter[],
  scoresByFilterId: ReadonlyMap<string, FilterScore>,
  opts: RotateOptions = {},
): RotationResult {
  const maxActive = opts.maxActive ?? 5;

  const scored = filters.map((filter) => ({
    filter,
    score: scoresByFilterId.get(filter.id) ?? { filterId: filter.id, score: 0, windowCount: 0, isFlat: false },
  }));

  const retired = scored.filter((s) => s.score.isFlat).map((s) => s.filter.id);
  const pool = scored.filter((s) => !s.score.isFlat).sort((a, b) => b.score.score - a.score.score);
  const active = pool.slice(0, maxActive).map((s) => s.filter.id);

  return { active, retired };
}
