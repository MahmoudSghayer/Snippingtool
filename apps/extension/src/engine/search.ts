/*
 * search.ts — the two ways a search reaches the governor (defect C1: before
 * this, none did, so `buyToSearchRatio` saw zero searches and denied every
 * buy after the first, and searches never counted toward `actionsPerHour`).
 *
 *   - `governedSearch` — every search the *extension* issues (assist's
 *     filter rotation today, anything automated later) must go through
 *     this, never `adapter.search()` directly: `governor.allow({kind:
 *     'search'})` first, and a denial skips the search rather than throwing.
 *   - `countObservedSearches` — searches the *human* runs in EA's own UI,
 *     which the extension only observes (assist mode's normal shape). These
 *     are not gated (they already happened) but they must count, or assist
 *     mode could never buy twice.
 */
import type { GovernorDecision, Governor } from './governor.js';
import type { ActionOutcome, AdapterClient } from '../content/adapter-client.js';
import type { FilterCriteria } from '@sl/shared';

export type GovernedSearchResult =
  | { searched: false; decision: GovernorDecision }
  | { searched: true; decision: GovernorDecision; outcome: ActionOutcome };

export async function governedSearch(governor: Governor, adapter: AdapterClient, filter: FilterCriteria): Promise<GovernedSearchResult> {
  const decision = governor.allow({ kind: 'search' });
  if (!decision.allowed) return { searched: false, decision };

  // `allow` already counted this search; its response will also arrive
  // through `adapter.onAuctions` (possibly more than once, possibly after
  // the dedupe window on a slow response), so mark it in flight until the
  // call settles.
  governor.beginEngineSearch();
  try {
    const outcome = await adapter.search(filter);
    return { searched: true, decision, outcome };
  } finally {
    governor.endEngineSearch();
  }
}

/** Subscribe to the adapter's search responses and count each one as an
 * observed search. `getGovernor` is a getter because `content/index.ts`
 * registers its adapter callbacks before the account-gated bootstrap has
 * created a governor (or decided there is none). Returns the unsubscribe. */
export function countObservedSearches(adapter: AdapterClient, getGovernor: () => Governor | null): () => void {
  return adapter.onAuctions(() => {
    getGovernor()?.recordObservedSearch();
  });
}
