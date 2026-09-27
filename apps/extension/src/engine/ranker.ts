/*
 * ranker.ts — the opportunity ranker (M2/M3).
 *
 * Scores a single candidate snipe, "simple statistics, no ML" per the price
 * model's own rule (docs/01-architecture.md, project instruction 7):
 * expected value per attempt = (predicted sale price x (1 - EA's 5% tax) -
 * snipe price) x P(sell in the window) — the same net-of-tax math
 * `model/prices.ts`'s `margin()` already does, made explicit here as the
 * ranker's own EV so `rankCandidates` has one thing to sort by.
 *
 * Filter rotation by realised coins/hour (`rotateFilters` /
 * `scoreFilterHistory`) was removed in P0 Task 13: nothing in the extension
 * produced the `filter_stats` history it scored (saved filters are local
 * only, so the API's `/filters/stats` has none of them either), so it never
 * ran. Assist cycles the user's active filters (`SavedFilter.isActive`), in
 * their order.
 *
 * Nothing here calls `adapter.act()` or `governor.allow()` — the ranker only
 * ever *proposes*; `engine/assist.ts`/`engine/autobuyer.ts` are the only
 * things that turn a ranked candidate into an action, and only through the
 * governor (docs/01-architecture.md, §3.4).
 */
import { EA_TAX, type PriceSummary } from '../model/prices.js';

// ---- 1. Opportunity scoring -------------------------------------------------

export interface OpportunityCandidate {
  resourceId: number;
  tradeId: string;
  /** The buy-now / snipe price under consideration — what `adapter.act('buy',
   * tradeId, price)` would be called with if this candidate is taken. */
  price: number;
  summary: PriceSummary;
  /** `false` when the adapter said it could not buy this listing
   * (TrimmedAuction.buyable): never ranked, so never attempted. */
  buyable?: boolean;
  /** The card's name and rating from the listing's item data, when it had
   * them: shown in the panel and the assist confirm overlay, never used to
   * score. */
  name?: string;
  rating?: number;
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
 * the same expected return). A candidate the adapter said it cannot buy
 * (`buyable: false`) is left out altogether. */
export function rankCandidates(candidates: OpportunityCandidate[], opts: RankOptions = {}): ScoredOpportunity[] {
  const minEv = opts.minEv ?? 0;
  return candidates
    .filter((c) => c.buyable !== false)
    .map((c) => ({ ...c, ...scoreOpportunity(c.summary, c.price) }))
    .filter((c) => c.ev >= minEv)
    .sort((a, b) => (b.ev !== a.ev ? b.ev - a.ev : a.price - b.price));
}
