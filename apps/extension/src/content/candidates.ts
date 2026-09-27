/*
 * candidates.ts — what assist and the autobuyer may act on: the listings of
 * the current search only (P0 Task 13). The ranker used to be fed every
 * listing tracked in the last ten minutes, so the confirm key could buy a
 * card from a search the user had long moved on from. Chrome-free.
 */
import type { OpportunityCandidate } from '../engine/ranker.js';
import type { PriceSummary } from '../model/prices.js';
import type { TrimmedAuction } from '@sl/shared';

/** The current search's listings as ranker candidates: unexpired, with a
 * buy-now price, not refused up front by the adapter (`buyable: false`),
 * and with a price summary for their card. Name and rating ride along for
 * the confirm overlay. */
export function currentCandidates(
  listings: readonly TrimmedAuction[],
  summaries: ReadonlyMap<number, PriceSummary>,
  now: number,
): OpportunityCandidate[] {
  const out: OpportunityCandidate[] = [];
  for (const a of listings) {
    if (a.expiresAt != null && a.expiresAt < now) continue;
    if (a.buyable === false || !(a.buyNow > 0)) continue;
    const summary = summaries.get(a.resourceId);
    if (!summary) continue;
    out.push({
      resourceId: a.resourceId,
      tradeId: a.tradeId,
      price: a.buyNow,
      summary,
      ...(a.name ? { name: a.name } : {}),
      rating: a.rating,
    });
  }
  return out;
}
