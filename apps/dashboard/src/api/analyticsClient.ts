// The analytics module (`/api/v1/analytics/me/*`, `/api/v1/admin/analytics/*`)
// is owned by a concurrent agent and, as of this pass, has not yet landed in
// `apps/api/openapi/openapi.json` — `packages/shared/src/schemas/analytics.ts`
// exists (so this file imports real types from it) but the routes
// themselves aren't in the generated `paths` type yet, so they can't go
// through `openapi-fetch`'s typed client (src/api/client.ts). This thin
// wrapper calls them directly by path, replays the same CSRF/credentials
// behaviour, and is built to swap over to `api.GET(...)` (openapi-fetch)
// with zero call-site changes once `pnpm --filter @sl/dashboard api:types`
// regenerates with these paths included — see docs/07-dashboard.md
// "Analytics endpoints (cross-agent dependency)" for the tracked follow-up.
import { API_BASE_URL, apiErrorMessage, isApiErrorBody, type ApiErrorBody } from './client.js';

function readCsrfCookie(): string | undefined {
  const match = document.cookie.match(/(?:^|;\s*)sl_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export interface AnalyticsResult<T> {
  data?: T;
  error?: ApiErrorBody;
}

export async function analyticsGet<T>(path: string, query?: Record<string, string | undefined>): Promise<AnalyticsResult<T>> {
  const search = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, value);
    }
  }
  const qs = search.toString();
  const url = `${API_BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  try {
    const response = await fetch(url, { credentials: 'include' });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (isApiErrorBody(body)) return { error: body };
      return {
        error: { code: response.status === 404 ? 'NOT_FOUND' : 'INTERNAL', message: `Request failed (${response.status})` },
      };
    }
    return { data: body as T };
  } catch {
    return { error: { code: 'INTERNAL', message: 'Analytics service is unreachable.' } };
  }
}

export async function analyticsPost<T>(path: string, body: unknown): Promise<AnalyticsResult<T>> {
  try {
    const csrf = readCsrfCookie();
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: JSON.stringify(body),
    });
    const responseBody: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (isApiErrorBody(responseBody)) return { error: responseBody };
      return { error: { code: 'INTERNAL', message: `Request failed (${response.status})` } };
    }
    return { data: responseBody as T };
  } catch {
    return { error: { code: 'INTERNAL', message: 'Analytics service is unreachable.' } };
  }
}

export { apiErrorMessage };
