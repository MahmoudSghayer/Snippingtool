/*
 * auth.ts — register/login/mfa/logout/refresh against `/api/v1/auth/*`
 * (schemas from `@sl/shared`), and the only owner of where tokens live:
 * the access token in `storage.session` (cleared when the browser closes,
 * never written to disk), the refresh token AES-GCM-encrypted
 * (`lib/storage.ts`) under a per-install key in `storage.local`
 * (docs/01-architecture.md, §3.1 and the extension<->apps/api trust
 * boundary).
 *
 * Deliberately does not import `lib/api.ts` — `api.ts` imports *this* file
 * (for `getValidAccessToken`/`handleUnauthorized`) to build its 401-refresh
 * interceptor, so the dependency only goes one way. Auth's own calls go
 * through `lib/http.ts`'s bare `retryFetch` instead.
 *
 * Refreshing is the delicate part: the API rotates the refresh token on
 * every use and treats a superseded one as stolen, revoking the session
 * (docs/04-auth.md §3). So a refresh runs in one context at a time across
 * every tab and the service worker (a Web Lock, where there is one — in the
 * userscript build every EA tab runs its own copy of this file over shared
 * storage), re-reads storage once it holds the lock (another context may
 * have refreshed meanwhile), and never sends its token again after an
 * attempt that may have reached the API without first checking whether
 * another context already rotated it.
 */
import {
  type LoginRequest,
  type LoginResponse,
  loginRequestSchema,
  type LogoutRequest,
  type MfaVerifyRequest,
  mfaVerifyRequestSchema,
  type RefreshResponse,
  type RegisterRequest,
  registerRequestSchema,
  type RegisterResponse,
  resendVerificationRequestSchema,
} from '@sl/shared';

import { backoffMs, NetworkError, retryFetch, sleep, toApiError, type ApiError } from './http.js';
import { decryptString, encryptString, getLocal, getSession, removeLocal, removeSession, setLocal, setSession } from './storage.js';

const ACCESS_TOKEN_KEY = 'sl.accessToken';
const REFRESH_TOKEN_ENC_KEY = 'sl.refreshTokenEnc';
/** Why this install was last signed out (`SignedOut`), kept until the next
 * sign-in. In `storage.local`, so every tab and the service worker see it. */
const SIGNED_OUT_KEY = 'sl.auth.signedOut';

/** Why the extension is signed out: the password changed (the API says so
 * when refusing the refresh), the session otherwise ended (revoked, reused,
 * expired), or the user signed out. */
export type SignedOutReason = 'password_changed' | 'session_ended' | 'user';

export interface SignedOut {
  reason: SignedOutReason;
  at: number;
}

async function persistTokens(accessToken: string, refreshToken: string): Promise<void> {
  await setSession(ACCESS_TOKEN_KEY, accessToken);
  await setLocal(REFRESH_TOKEN_ENC_KEY, await encryptString(refreshToken));
}

export async function clearTokens(): Promise<void> {
  await removeSession(ACCESS_TOKEN_KEY);
  await removeLocal(REFRESH_TOKEN_ENC_KEY);
}

async function signOut(reason: SignedOutReason): Promise<void> {
  await clearTokens();
  await setLocal(SIGNED_OUT_KEY, { reason, at: Date.now() } satisfies SignedOut);
}

/** Why the extension was last signed out, or null while signed in (and on
 * an install that never signed out). */
export async function lastSignOut(): Promise<SignedOut | null> {
  return getLocal<SignedOut | null>(SIGNED_OUT_KEY, null);
}

async function signedIn(accessToken: string, refreshToken: string): Promise<void> {
  await persistTokens(accessToken, refreshToken);
  await removeLocal(SIGNED_OUT_KEY);
}

/** The one startup refresh (`refreshOnStartup`), while or once it runs. */
let startupRefresh: Promise<boolean> | null = null;

/** Whether there is an access token this browser session. Waits for the
 * startup refresh when one is in flight, so a tab asking right after a
 * browser restart is not told "signed out" a moment before it is not. */
export async function isAuthenticated(): Promise<boolean> {
  if (startupRefresh) await startupRefresh;
  return (await getSession<string | null>(ACCESS_TOKEN_KEY, null)) != null;
}

/** Called once when background starts (P0 Task 13). The access token lives
 * in `storage.session`, so a browser restart clears it while the refresh
 * token (`storage.local`) survives: without this the extension acted signed
 * out, with no entitlement, until the next sign-in. One refresh, once per
 * service-worker start, and only when there is a refresh token and no
 * access token. Never throws; resolves whether it is signed in. */
export function refreshOnStartup(): Promise<boolean> {
  startupRefresh ??= (async () => {
    if ((await getSession<string | null>(ACCESS_TOKEN_KEY, null)) != null) return true;
    if ((await getLocal<string | null>(REFRESH_TOKEN_ENC_KEY, null)) == null) return false;
    try {
      return await handleUnauthorized();
    } catch {
      return false; // offline: the API calls' own 401 path tries again later
    }
  })();
  return startupRefresh;
}

/** Whether this install is signed in to an account at all: an access
 * token this browser session, or a stored refresh token (the access token
 * lives in `storage.session`, so it is gone after a browser restart until
 * the next refresh, while the account very much still exists). */
export async function hasAccount(): Promise<boolean> {
  if (await isAuthenticated()) return true;
  return (await getLocal<string | null>(REFRESH_TOKEN_ENC_KEY, null)) != null;
}

export async function getValidAccessToken(): Promise<string | null> {
  return getSession<string | null>(ACCESS_TOKEN_KEY, null);
}

async function getDecryptedRefreshToken(): Promise<string | null> {
  const enc = await getLocal<string | null>(REFRESH_TOKEN_ENC_KEY, null);
  if (!enc) return null;
  try {
    return await decryptString(enc);
  } catch {
    return null; // corrupt/undecryptable — treat as logged out rather than throw
  }
}

/** The Web Lock every context refreshes under. */
export const REFRESH_LOCK = 'sl-auth-refresh';

/** How long one refresh keeps retrying an API that does not answer (network
 * error, 5xx, 429) or answers "another request just rotated it" (409),
 * before giving up for now with the tokens kept. Well inside the API's
 * 30 s refresh grace (docs/04-auth.md §3): an attempt that reached the API
 * and rotated the token, but whose answer was lost, is retried while the
 * API still takes that retry for what it is. */
const REFRESH_RETRY_BUDGET_MS = 12_000;
/** The wait after a 409: the other request's answer is on its way. */
const CONFLICT_RETRY_MS = 250;
/** The longest a refresh waits for `REFRESH_LOCK`: longer than any refresh
 * holds it (the retry budget, plus a request in flight). */
const LOCK_WAIT_MS = REFRESH_RETRY_BUDGET_MS + 15_000;

function defaultRetryDelay(attempt: number, status: number | null): number {
  return status === 409 ? CONFLICT_RETRY_MS : backoffMs(attempt);
}

let retryBudgetMs = REFRESH_RETRY_BUDGET_MS;
let retryDelay = defaultRetryDelay;
let lockWaitMs = LOCK_WAIT_MS;

/** Tests only: shortens the retry budget, the waits between attempts and
 * the wait for the lock (`null` restores all three). */
export function setRefreshRetryForTests(
  opts: { budgetMs?: number; delay?: (attempt: number, status: number | null) => number; lockWaitMs?: number } | null,
): void {
  retryBudgetMs = opts?.budgetMs ?? REFRESH_RETRY_BUDGET_MS;
  retryDelay = opts?.delay ?? defaultRetryDelay;
  lockWaitMs = opts?.lockWaitMs ?? LOCK_WAIT_MS;
}

/** A refresh answer that says nothing about the token itself: try again. */
function isTransient(status: number): boolean {
  return status >= 500 || status === 429 || status === 409;
}

function signOutReasonFor(error: ApiError): SignedOutReason {
  return error.details?.reason === 'password_changed' ? 'password_changed' : 'session_ended';
}

/** One refresh with `presented`, the stored refresh token. Resolves true
 * when there are fresh tokens in storage (ours, or another context's),
 * false when the session is over (tokens cleared); rejects (`NetworkError`,
 * or the 5xx/429/409 `ApiError`) when no usable answer came for the whole
 * retry budget, keeping the tokens for a later attempt. */
async function doRefresh(presented: string): Promise<boolean> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let unreachable: unknown = null;
    try {
      // One request per attempt (`retries: 0`): a retry is decided below,
      // after re-reading storage, never blindly by retryFetch.
      res = await retryFetch('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: presented }) }, { retries: 0 });
    } catch (err) {
      unreachable = err;
    }
    if (res?.ok) {
      const data = (await res.json()) as RefreshResponse;
      await persistTokens(data.accessToken, data.refreshToken);
      return true;
    }
    // The attempt may have reached the API, and rotated `presented`, even
    // though no usable answer came back. If another context rotated it
    // meanwhile, its tokens are ours too: `presented` is never sent again.
    const stored = await getDecryptedRefreshToken();
    if (stored !== presented) return stored != null;
    if (res && !isTransient(res.status)) {
      // A reused/expired/revoked refresh token means this session is over —
      // AUTH_TOKEN_REUSED / AUTH_SESSION_REVOKED both mean "force re-login",
      // never "keep retrying with the same token" (docs/01-architecture.md, §3.1).
      await signOut(signOutReasonFor(await toApiError(res)));
      return false;
    }
    const delay = retryDelay(attempt, res?.status ?? null);
    if (Date.now() - startedAt + delay > retryBudgetMs) {
      if (res) throw await toApiError(res);
      throw unreachable instanceof NetworkError ? unreachable : new NetworkError(unreachable);
    }
    // Still `presented` in storage: sending it again is safe. If the last
    // attempt did rotate it, the API takes this for the retry it is (the
    // refresh grace) and answers with a fresh pair.
    await sleep(delay);
  }
}

function lockManager(): LockManager | null {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/** Refreshes unless another context already did since `rejectedAccess`
 * (the access token the API refused; `undefined`: whatever is stored now)
 * was current. Exclusive across contexts under the `REFRESH_LOCK` Web Lock
 * where there is one; without it (tests, old browsers) the single-flight in
 * `handleUnauthorized` is all there is. */
async function refreshExclusively(rejectedAccess: string | null | undefined): Promise<boolean> {
  const seenRefresh = await getDecryptedRefreshToken();
  if (!seenRefresh) return false;
  const seenAccess = rejectedAccess === undefined ? await getValidAccessToken() : rejectedAccess;
  const locks = lockManager();
  if (!locks) return doRefresh(seenRefresh);
  const underLock = async (): Promise<boolean> => {
    // Another tab may have refreshed while this one waited: a different
    // refresh token, or a fresh access token, means it did.
    const refreshNow = await getDecryptedRefreshToken();
    if (!refreshNow) return false;
    if (refreshNow !== seenRefresh) return true;
    const accessNow = await getValidAccessToken();
    if (accessNow != null && accessNow !== seenAccess) return true;
    return doRefresh(refreshNow);
  };
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(lockWaitMs) : undefined;
  try {
    return await (timeout ? locks.request(REFRESH_LOCK, { signal: timeout }, underLock) : locks.request(REFRESH_LOCK, underLock));
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name !== 'TimeoutError' && name !== 'AbortError') throw err;
    // Not granted in time: something holds the lock far longer than a
    // refresh takes (a hung request; in the userscript build, EA's page
    // shares the lock names of its origin). Carry on without it, still
    // re-reading storage first.
    return underLock();
  }
}

let refreshInFlight: Promise<boolean> | null = null;

/** Single-flight: concurrent callers (multiple in-flight `apiFetch` calls
 * that all hit a 401 at once) share one refresh request instead of each
 * racing their own; across contexts, `refreshExclusively`. Pass the access
 * token the API refused, so a refresh another context already made is
 * picked up instead of repeated. Resolves whether there are fresh tokens;
 * rejects when the API could not be reached (tokens kept). */
export async function handleUnauthorized(rejectedAccess?: string | null): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = refreshExclusively(rejectedAccess).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** `POST /auth/register` never returns tokens (201 `{ userId }` — see
 * `registerResponseSchema`'s own comment); email verification is required
 * before login works. Previously this was mistyped as `LoginResponse` and
 * gated on `data.status === 'ok'`, a field the real response never has, so
 * nothing was ever persisted and the caller (`background/auth.ts`'s
 * `handleAuthRegister`) had no way to tell a fresh registration apart from
 * a login — it's now typed and returned as what it actually is. */
export async function register(request: RegisterRequest): Promise<RegisterResponse> {
  const body = registerRequestSchema.parse(request);
  const res = await retryFetch('/api/v1/auth/register', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as RegisterResponse;
}

/** `POST /auth/resend-verification` — re-sends the verification email for
 * an unverified account. Always resolves `{ sent: true }` server-side
 * regardless of whether the address exists (docs/03-api.md — avoids
 * account enumeration), so the caller only needs to handle the request
 * failing outright (rate-limited, validation). */
export async function resendVerification(email: string): Promise<{ sent: true }> {
  const body = resendVerificationRequestSchema.parse({ email });
  const res = await retryFetch('/api/v1/auth/resend-verification', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { sent: true };
}

export async function login(request: LoginRequest): Promise<LoginResponse> {
  const body = loginRequestSchema.parse(request);
  const res = await retryFetch('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await toApiError(res);
  const data = (await res.json()) as LoginResponse;
  if (data.status === 'ok') await signedIn(data.accessToken, data.refreshToken);
  return data;
}

export async function verifyMfa(request: MfaVerifyRequest): Promise<LoginResponse> {
  const body = mfaVerifyRequestSchema.parse(request);
  const res = await retryFetch('/api/v1/auth/mfa/verify', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await toApiError(res);
  const data = (await res.json()) as LoginResponse;
  if (data.status === 'ok') await signedIn(data.accessToken, data.refreshToken);
  return data;
}

export async function logout(allDevices = false): Promise<void> {
  const refreshToken = (await getDecryptedRefreshToken()) ?? undefined;
  const body: LogoutRequest = { refreshToken, allDevices };
  try {
    await retryFetch('/api/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: (await getValidAccessToken())
        ? { authorization: `Bearer ${await getValidAccessToken()}` }
        : undefined,
    });
  } finally {
    await signOut('user');
  }
}
