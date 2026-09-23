/*
 * http.ts — the retry/backoff primitive shared by `lib/api.ts` (authenticated
 * calls) and `lib/auth.ts` (the `/auth/*` calls that must never go through
 * `api.ts`'s 401-refresh interceptor, since refresh/login/register/mfa are
 * exactly the calls the interceptor exists to protect against looping on).
 * Kept dependency-free from both so neither imports the other.
 */
export const API_ORIGIN = import.meta.env.VITE_API_ORIGIN;

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

let fetchImpl: FetchImpl = (input, init) => fetch(input, init);

/** Swaps the transport every API call goes through. The extension builds
 * never call this — their pages reach the API with the manifest's
 * host_permissions. The userscript build runs on ea.com's origin, where a
 * plain `fetch` to the API is a cross-origin request, so it installs a
 * `GM_xmlhttpRequest`-backed implementation instead
 * (`src/userscript/gm-fetch.ts`). */
export function setFetchImpl(impl: FetchImpl): void {
  fetchImpl = impl;
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryFetchOptions {
  retries?: number;
  /** Called with each attempt's headers before the request fires, so a
   * caller can attach an `authorization` header without this module needing
   * to know about tokens at all. */
  authorize?: (headers: Headers) => Promise<void> | void;
}

/** Fetch with an `x-request-id` on every attempt and exponential
 * backoff + jitter on network failure / 429 / 5xx. Does not interpret 401 —
 * that is `lib/api.ts`'s job (refresh-and-retry) for authenticated calls, or
 * simply "the credentials were wrong" for `lib/auth.ts`'s own calls. */
export async function retryFetch(path: string, init: RequestInit = {}, opts: RetryFetchOptions = {}): Promise<Response> {
  const maxRetries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    const headers = new Headers(init.headers);
    headers.set('x-request-id', crypto.randomUUID());
    if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
    if (opts.authorize) await opts.authorize(headers);

    try {
      const res = await fetchImpl(`${API_ORIGIN}${path}`, { ...init, headers });
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await sleep(backoffMs(attempt));
      attempt++;
    }
  }
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  try {
    const body = (await res.json()) as ApiErrorBody;
    return new ApiError(res.status, body.error?.code ?? 'INTERNAL', body.error?.message ?? res.statusText, requestId);
  } catch {
    return new ApiError(res.status, 'INTERNAL', res.statusText, requestId);
  }
}
