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

import { retryFetch, toApiError } from './http.js';
import { decryptString, encryptString, getLocal, getSession, removeLocal, removeSession, setLocal, setSession } from './storage.js';

const ACCESS_TOKEN_KEY = 'sl.accessToken';
const REFRESH_TOKEN_ENC_KEY = 'sl.refreshTokenEnc';

async function persistTokens(accessToken: string, refreshToken: string): Promise<void> {
  await setSession(ACCESS_TOKEN_KEY, accessToken);
  await setLocal(REFRESH_TOKEN_ENC_KEY, await encryptString(refreshToken));
}

export async function clearTokens(): Promise<void> {
  await removeSession(ACCESS_TOKEN_KEY);
  await removeLocal(REFRESH_TOKEN_ENC_KEY);
}

export async function isAuthenticated(): Promise<boolean> {
  return (await getSession<string | null>(ACCESS_TOKEN_KEY, null)) != null;
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

let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const refreshToken = await getDecryptedRefreshToken();
  if (!refreshToken) return false;
  const res = await retryFetch('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  if (!res.ok) {
    // A reused/expired/revoked refresh token means this session is over —
    // AUTH_TOKEN_REUSED / AUTH_SESSION_REVOKED both mean "force re-login",
    // never "keep retrying with the same token" (docs/01-architecture.md, §3.1).
    await clearTokens();
    return false;
  }
  const data = (await res.json()) as RefreshResponse;
  await persistTokens(data.accessToken, data.refreshToken);
  return true;
}

/** Single-flight: concurrent callers (multiple in-flight `apiFetch` calls
 * that all hit a 401 at once) share one refresh request instead of each
 * racing their own. */
export async function handleUnauthorized(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
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
  if (data.status === 'ok') await persistTokens(data.accessToken, data.refreshToken);
  return data;
}

export async function verifyMfa(request: MfaVerifyRequest): Promise<LoginResponse> {
  const body = mfaVerifyRequestSchema.parse(request);
  const res = await retryFetch('/api/v1/auth/mfa/verify', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw await toApiError(res);
  const data = (await res.json()) as LoginResponse;
  if (data.status === 'ok') await persistTokens(data.accessToken, data.refreshToken);
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
    await clearTokens();
  }
}
