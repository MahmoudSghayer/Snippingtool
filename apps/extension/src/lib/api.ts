/*
 * api.ts — the one place `background/*` calls authenticated `apps/api`
 * endpoints from. Bearer auth (attached via `authorize`) with single-flight
 * refresh-on-401 (delegated to `lib/auth.ts`, which owns the token store) —
 * see `lib/http.ts` for the shared retry/backoff primitive this builds on.
 *
 * `content/index.ts` never imports this file directly — it hands batched
 * data to `background/*` over `chrome.runtime` messages, and background is
 * the only thing that talks to the network (docs/01-architecture.md, trust
 * boundary table).
 */
import { getValidAccessToken, handleUnauthorized } from './auth.js';
import { retryFetch, toApiError, type RetryFetchOptions } from './http.js';

export { ApiError, API_ORIGIN } from './http.js';

export async function apiFetch(path: string, init: RequestInit = {}, opts: RetryFetchOptions = {}): Promise<Response> {
  let refreshedOnce = false;
  for (;;) {
    const res = await retryFetch(path, init, {
      ...opts,
      authorize: async (headers) => {
        const token = await getValidAccessToken();
        if (token) headers.set('authorization', `Bearer ${token}`);
      },
    });

    if (res.status === 401 && !refreshedOnce) {
      refreshedOnce = true;
      const refreshed = await handleUnauthorized();
      if (refreshed) continue; // retry once, immediately, with the fresh token
    }
    return res;
  }
}

export async function apiJson<T>(path: string, init: RequestInit = {}, opts: RetryFetchOptions = {}): Promise<T> {
  const res = await apiFetch(path, init, opts);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}
