// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Unit coverage for lib/api.ts's 401-refresh interceptor and lib/auth.ts's
// single-flight `handleUnauthorized()`, previously untested: concurrent
// requests that all hit a 401 at once must share exactly one refresh
// request, not each race their own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from '../../src/lib/api.js';
import { clearTokens, isAuthenticated } from '../../src/lib/auth.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('lib/api.ts + lib/auth.ts: single-flight 401 refresh', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await clearTokens();
    // Seed a plaintext session access token and an encrypted refresh token,
    // exactly as auth.ts's own `persistTokens()` would after a real login —
    // driven through the real login flow would need a live server, so this
    // seeds the same storage shape directly (the encryption itself is
    // exercised for real, via lib/storage.ts's actual AES-GCM helpers).
    const { setSession, setLocal, encryptString } = await import('../../src/lib/storage.js');
    await setSession('sl.accessToken', 'expired-access-token');
    await setLocal('sl.refreshTokenEnc', await encryptString('a-valid-refresh-token'));

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes once and retries the original request with the new token', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-access-token', refreshToken: 'fresh-refresh-token' });
      }
      // Every other call: authorized -> 200, everything else -> 401.
      return jsonResponse(200, { ok: true });
    });

    // First call to the protected route 401s, then the interceptor retries with the fresh token.
    let protectedCallCount = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'fresh-access-token', refreshToken: 'fresh-refresh-token' });
      }
      protectedCallCount++;
      const auth = new Headers(init.headers).get('authorization');
      if (auth === 'Bearer fresh-access-token') return jsonResponse(200, { ok: true });
      return jsonResponse(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } });
    });

    const res = await apiFetch('/api/v1/users/me');
    expect(res.status).toBe(200);
    expect(protectedCallCount).toBe(2); // one 401, one retry
    expect(await isAuthenticated()).toBe(true);
  });

  it('concurrent requests that all 401 at once share exactly one refresh call', async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        refreshCalls++;
        // Simulate real network latency so the concurrent callers actually overlap.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse(200, { accessToken: 'fresh-access-token', refreshToken: 'fresh-refresh-token' });
      }
      const auth = new Headers(init.headers).get('authorization');
      if (auth === 'Bearer fresh-access-token') return jsonResponse(200, { ok: true });
      return jsonResponse(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } });
    });

    const results = await Promise.all([
      apiFetch('/api/v1/devices'),
      apiFetch('/api/v1/sessions'),
      apiFetch('/api/v1/notifications'),
    ]);

    expect(refreshCalls).toBe(1);
    for (const res of results) expect(res.status).toBe(200);
  });

  it('a failed refresh (revoked/reused token) clears stored tokens and does not retry', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        return jsonResponse(401, { error: { code: 'AUTH_SESSION_REVOKED', message: 'revoked' } });
      }
      return jsonResponse(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } });
    });

    const res = await apiFetch('/api/v1/users/me');
    expect(res.status).toBe(401); // no retry succeeded — the original 401 (post-refresh-attempt) is returned
    expect(await isAuthenticated()).toBe(false);
  });

  it('only ever attempts one refresh per apiFetch call, even if the retried request 401s again', async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        refreshCalls++;
        return jsonResponse(200, { accessToken: 'fresh-access-token', refreshToken: 'fresh-refresh-token' });
      }
      // The protected route always 401s, even with the "fresh" token (e.g. it was itself revoked server-side moments later).
      return jsonResponse(401, { error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } });
    });

    const res = await apiFetch('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(refreshCalls).toBe(1); // not looped
  });
});
