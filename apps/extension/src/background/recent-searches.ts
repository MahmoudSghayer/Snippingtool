/*
 * recent-searches.ts — background handlers for the Nova AI page's Recent
 * searches log as the signed-in account keeps it (`recentSearches.get` /
 * `recentSearches.set`, `/api/v1/extension/recent-searches`), so every
 * browser the trader signs in on shows the same list. Content keeps the
 * local copy (content/recent-searches.ts): null here, signed out or
 * offline, means "use it". Automation builds only, like background/bot.ts.
 */
import {
  recentSearchesResponseSchema,
  type PutRecentSearchesRequest,
  type RecentSearchesResponse,
} from '@sl/shared';

import { apiJson, NetworkError } from '../lib/api.js';
import { isAuthenticated } from '../lib/auth.js';

/** Unreachable is an answer here, not a failure: the page has its local
 * copy. Anything the API itself refused still throws (and is logged). */
async function unlessOffline<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof NetworkError) return null;
    throw err;
  }
}

/** The account's list, re-validated on the way in (anything else reads as
 * none, and content falls back to its copy). */
export async function handleRecentSearchesGet(): Promise<RecentSearchesResponse | null> {
  if (!(await isAuthenticated())) return null;
  // One retry: the page is waiting on this to show the list.
  const body = await unlessOffline(() => apiJson<unknown>('/api/v1/extension/recent-searches', {}, { retries: 1 }));
  const parsed = recentSearchesResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Replaces the account's list with `payload.items` (already checked
 * against `putRecentSearchesRequestSchema` by background/index.ts). */
export async function handleRecentSearchesSet(payload: PutRecentSearchesRequest): Promise<RecentSearchesResponse | null> {
  if (!(await isAuthenticated())) return null;
  return unlessOffline(() =>
    apiJson<RecentSearchesResponse>(
      '/api/v1/extension/recent-searches',
      { method: 'PUT', body: JSON.stringify(payload) },
      { retries: 1 },
    ),
  );
}
