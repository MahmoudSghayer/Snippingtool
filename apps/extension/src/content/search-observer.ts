/*
 * search-observer.ts — content's handler for one `auctions` message from
 * the adapter, which is one search: the panel's search counter, the
 * tracked listings the ranker works from, one telemetry `search` event and
 * one batch of ledger rows. Split out of content/index.ts (which wires it)
 * so "one search in, one of each out" is testable against the real
 * adapter (test/unit/adapter-shapes.test.ts). Chrome-free.
 */
import type { TrimmedAuction } from '@sl/shared';

const TRACKED_TTL_MS = 10 * 60 * 1000;

export interface SearchObserverDeps {
  /** The listings content ranks from, keyed by tradeId. Updated in place. */
  tracked: Map<string, TrimmedAuction>;
  /** Called with the running search count (the panel counter). */
  onSearch: (count: number) => void;
  /** The card most of this search's listings are, and its rating. */
  onDominant?: (resourceId: number, rating: number | null) => void;
  /** One telemetry `search` event. `resource:<id>` is a coarse, documented
   * stand-in filter hash: the adapter sees the response, not the request
   * (docs/06-extension.md). */
  reportSearch: (filterHash: string, auctions: TrimmedAuction[]) => void;
  /** One batch of ledger rows. */
  record: (auctions: TrimmedAuction[]) => void;
}

function dominantResource(auctions: TrimmedAuction[]): number | null {
  const tally = new Map<number, number>();
  for (const a of auctions) tally.set(a.resourceId, (tally.get(a.resourceId) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [id, n] of tally) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best != null && bestN / auctions.length >= 0.5 ? best : null;
}

export function createSearchObserver(deps: SearchObserverDeps): (auctions: TrimmedAuction[]) => void {
  let searches = 0;
  return (auctions) => {
    deps.onSearch(++searches);

    for (const a of auctions) deps.tracked.set(a.tradeId, a);
    // Prune anything long expired so `tracked` doesn't grow without bound.
    const cutoff = Date.now() - TRACKED_TTL_MS;
    for (const [id, a] of deps.tracked) if (a.expiresAt != null && a.expiresAt < cutoff) deps.tracked.delete(id);

    if (auctions.length === 0) return;
    const dominant = dominantResource(auctions);
    if (dominant != null) deps.onDominant?.(dominant, auctions.find((a) => a.resourceId === dominant)?.rating ?? null);
    deps.reportSearch(dominant != null ? `resource:${dominant}` : 'mixed', auctions);
    deps.record(auctions);
  };
}
