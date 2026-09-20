// Typed API client (openapi-fetch + the generated `paths` type). Every call
// site in the dashboard imports `api` from here rather than calling `fetch`
// directly, so cookie credentials, the CSRF header and 401 handling are
// applied uniformly (docs/04-auth.md §1, §10; docs/07-dashboard.md "Auth/CSRF
// handling").
import createClient from 'openapi-fetch';

import type { Middleware } from 'openapi-fetch';
import type { paths } from './schema.js';

/** `VITE_API_ORIGIN` unset -> relative `/api/v1` (dev proxy / same-origin
 * Vercel setup). Set -> an absolute cross-origin base URL (see
 * apps/dashboard/.env.example and docs/07-dashboard.md for what the API side
 * must configure either way). */
const apiOrigin = import.meta.env.VITE_API_ORIGIN?.replace(/\/$/, '') ?? '';
export const API_BASE_URL = `${apiOrigin}/api/v1`;

/** Reads the (non-httpOnly, signed) `sl_csrf` cookie the dashboard's own JS
 * is meant to read per docs/04-auth.md §10 — the double-submit token, not a
 * secret. */
function readCsrfCookie(): string | undefined {
  const match = document.cookie.match(/(?:^|;\s*)sl_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
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
 * redirect flow itself. */
const AUTH_EXEMPT_PATH_FRAGMENTS = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/mfa/verify'];

const csrfAndCredentialsMiddleware: Middleware = {
  async onRequest({ request }) {
    request.credentials = 'include';
    if (MUTATING_METHODS.has(request.method)) {
      const token = readCsrfCookie();
      if (token) request.headers.set('x-csrf-token', token);
    }
    return request;
  },
  async onResponse({ request, response }) {
    if (response.status === 401) {
      const isExempt = AUTH_EXEMPT_PATH_FRAGMENTS.some((fragment) => request.url.includes(fragment));
      if (!isExempt && unauthorizedHandler) {
        unauthorizedHandler(window.location.pathname + window.location.search);
      }
    }
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: API_BASE_URL });
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

export function apiErrorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (isApiErrorBody(error)) return error.message;
  return fallback;
}
