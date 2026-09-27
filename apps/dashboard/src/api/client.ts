// Typed API client (openapi-fetch + the generated `paths` type). Every call
// site in the dashboard imports `api` from here rather than calling `fetch`
// directly, so cookie credentials, the CSRF header and 401 handling are
// applied uniformly (docs/04-auth.md §1, §10; docs/07-dashboard.md "Auth/CSRF
// handling").
import createClient from 'openapi-fetch';

import type { paths } from './schema.js';
import type { Middleware } from 'openapi-fetch';

/** `VITE_API_ORIGIN` unset -> relative (empty) base, so requests hit the
 * dev-proxy / same-origin Vercel deployment. Set -> an absolute cross-origin
 * base URL (see apps/dashboard/.env.example and docs/07-dashboard.md for
 * what the API side must configure either way).
 *
 * Deliberately just the origin, **not** `${origin}/api/v1` — every path key
 * in the generated `paths` type (src/api/schema.d.ts, from
 * apps/api/openapi/openapi.json) already includes the `/api/v1` prefix
 * (Fastify's route prefix is baked into each OpenAPI path, not stripped via
 * a `servers` entry), so every `api.GET(...)`/`api.POST(...)` call site
 * writes the full `/api/v1/...` path — see docs/07-dashboard.md "API client
 * base URL" for the full rationale, including why doubling this prefix here
 * was an early bug this comment now guards against. */
const apiOrigin = import.meta.env.VITE_API_ORIGIN?.replace(/\/$/, '') ?? '';
export const API_BASE_URL = apiOrigin;

/** Reads the (non-httpOnly, signed) `sl_csrf` cookie the dashboard's own JS
 * is meant to read per docs/04-auth.md §10 — the double-submit token, not a
 * secret. */
function readCsrfCookie(): string | undefined {
  const match = document.cookie.match(/(?:^|;\s*)sl_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** The same token, as the API last returned it in its `x-csrf-token`
 * response header (apps/api/src/plugins/csrf.ts). When the API is on
 * another site than the dashboard (Vercel + the VM), `document.cookie` never
 * holds the API host's `sl_csrf`, so this is the only copy the JS can see. */
let csrfFromResponse: string | undefined;

/** Forgets the remembered token (sign-out, `clearLocalSession`); the next
 * API response brings one again. */
export function forgetCsrfToken(): void {
  csrfFromResponse = undefined;
}

function readCsrfToken(): string | undefined {
  return readCsrfCookie() ?? csrfFromResponse;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Set by the app root once the router exists, so this module (which has no
 * dependency on the router) can still redirect on a 401 without a global. */
let unauthorizedHandler: ((path: string) => void) | undefined;
export function setUnauthorizedHandler(handler: (path: string) => void): void {
  unauthorizedHandler = handler;
}

/** Paths that must not trigger the 401 redirect loop: login itself
 * legitimately 401s on bad credentials, and refresh/logout run during the
 * redirect flow itself. Also gates the silent-refresh attempt below (defect
 * C8) — a 401 on `/auth/refresh` or `/auth/login` must never itself trigger
 * another refresh, or a truly-dead session would loop forever. */
const AUTH_EXEMPT_PATH_FRAGMENTS = [
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/auth/mfa/verify',
];

/** The two `authenticate` error codes (apps/api/src/plugins/auth.ts) that
 * mean "the access token itself is the problem" — expired (`sl_at`'s 15min
 * TTL elapsed) or simply absent (no cookie / no bearer header) — which a
 * refresh can fix. Deliberately narrower than "every 401": AUTH_SESSION_REVOKED
 * (row_version bumped by a password change/force-logout) and
 * AUTH_TOKEN_REUSED (refresh-token reuse) mean the *session* is gone, not
 * just the access token, so retrying after a refresh would either fail
 * anyway or paper over a real revocation. */
const REFRESHABLE_AUTH_CODES = new Set(['AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID']);

/** Single-flight refresh (defect C8): two requests racing into a 401 at the
 * same moment must not each fire their own `POST /auth/refresh` — the API
 * rotates the refresh token on every use and treats a second presentation
 * of the now-superseded token as reuse, revoking the whole session family
 * (apps/api/src/modules/auth/service.ts `refresh`). Concurrent callers
 * instead await this one shared promise; it's reset to `null` once the
 * in-flight refresh settles, so the *next* 401 (not concurrent with this
 * one) starts a fresh refresh rather than replaying a stale result. */
let refreshPromise: Promise<boolean> | null = null;

function silentRefresh(fetchFn: typeof fetch): Promise<boolean> {
  if (!refreshPromise) {
    // No CSRF header needed: `/auth/refresh` has no `verifyCsrf` preHandler
    // (apps/api/src/modules/auth/index.ts) — it authenticates via the
    // `sl_rt` cookie alone, which `credentials: 'include'` already attaches.
    refreshPromise = api
      .POST('/api/v1/auth/refresh', { body: {}, fetch: fetchFn })
      .then(({ error }) => !error)
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    // `.clone()` so this read doesn't consume the body openapi-fetch's own
    // caller still needs to parse into `{ data, error }`.
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

/** Keyed by openapi-fetch's own per-request `id` (stable across its
 * `onRequest`/`onResponse` pair for one call): an unconsumed clone of the
 * request exactly as it was sent (post CSRF-header), taken in `onRequest`
 * before anything can read its body — so a 401 caused by an expired access
 * token can be replayed byte-for-byte after a silent refresh, without
 * re-running request construction (which `onResponse` has no hook into).
 * Every entry is removed in `onResponse`/`onError`, so this never holds more
 * than the requests currently in flight. */
const pendingRequestClones = new Map<string, Request>();

// `credentials` is a read-only property on a constructed `Request`, so it
// can't be set from inside `onRequest` — it's passed to `createClient`
// below instead (openapi-fetch forwards it into the `Request` it builds).
const csrfAndCredentialsMiddleware: Middleware = {
  async onRequest({ request, id }) {
    if (MUTATING_METHODS.has(request.method)) {
      const token = readCsrfToken();
      if (token) request.headers.set('x-csrf-token', token);
    }
    pendingRequestClones.set(id, request.clone());
    return request;
  },
  async onResponse({ request, response, id, options }) {
    const clonedRequest = pendingRequestClones.get(id);
    pendingRequestClones.delete(id);
    const echoedCsrf = response.headers.get('x-csrf-token');
    if (echoedCsrf) csrfFromResponse = echoedCsrf;

    if (response.status !== 401) return response;

    const isExempt = AUTH_EXEMPT_PATH_FRAGMENTS.some((fragment) =>
      request.url.includes(fragment),
    );

    if (!isExempt && clonedRequest) {
      const body = await readErrorBody(response);
      if (isApiErrorBody(body) && REFRESHABLE_AUTH_CODES.has(body.code)) {
        const refreshed = await silentRefresh(options.fetch);
        if (refreshed) {
          // Re-read the CSRF cookie right before replaying, rather than
          // reusing whatever `onRequest` captured on the original clone: on
          // a fresh browser session (no `sl_csrf` cookie yet), the *first*
          // request carries no CSRF header, and the CSRF plugin's own
          // `onRequest` hook mints the cookie on the server while handling
          // that very request — its `Set-Cookie` lands on this 401 response
          // and the browser applies it before this code runs. Replaying
          // with the original (missing/stale) header would needlessly fail
          // `verifyCsrf` on the retry.
          if (MUTATING_METHODS.has(clonedRequest.method)) {
            const csrfToken = readCsrfToken();
            if (csrfToken) clonedRequest.headers.set('x-csrf-token', csrfToken);
          }
          const retryResponse = await options.fetch(clonedRequest);
          if (retryResponse.status !== 401) return retryResponse;
          // Still unauthorized even after a successful refresh (e.g. the
          // session was revoked in the gap between refresh and retry) —
          // don't hand the caller a bare 401; fall through to the same
          // "clear auth state and redirect to login" path below, against
          // *this* response rather than the original one.
          response = retryResponse;
        }
        // Refresh failed (refresh token also expired/invalid/reused) — fall
        // through to the same "clear auth state and redirect to login"
        // behaviour as any other unrecoverable 401, below.
      }
    }

    if (!isExempt && unauthorizedHandler) {
      unauthorizedHandler(window.location.pathname + window.location.search);
    }
    return response;
  },
  onError({ id }) {
    pendingRequestClones.delete(id);
  },
};

export const api = createClient<paths>({ baseUrl: API_BASE_URL, credentials: 'include' });
api.use(csrfAndCredentialsMiddleware);

/** Every `@sl/shared` error envelope shape (`{ code, message, details?,
 * requestId }`), narrowed from whatever openapi-fetch's `error` came back as. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

export function apiErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (isApiErrorBody(error)) return error.message;
  return fallback;
}
