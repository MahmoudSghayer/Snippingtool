import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, setUnauthorizedHandler } from '@/api/client.js';

/** Covers docs/04-auth.md §10's CSRF model as implemented by
 * src/api/client.ts: the `x-csrf-token` header is attached to mutating
 * requests from the `sl_csrf` cookie, never to GETs, and a 401 response
 * invokes the registered unauthorized handler (unless the request is one of
 * the auth-exempt paths, e.g. /auth/login itself). */
describe('api client CSRF + 401 handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.cookie = 'sl_csrf=test-csrf-token; path=/';
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  });

  afterEach(() => {
    document.cookie = 'sl_csrf=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    setUnauthorizedHandler(() => {});
  });

  // `fetch` is passed per-call (openapi-fetch's own override hook) rather
  // than stubbed globally: `api` is a module-level singleton created once at
  // import time, before any test's `beforeEach` runs, and openapi-fetch
  // resolves `globalThis.fetch` at client-creation time — a later
  // `vi.stubGlobal('fetch', ...)` in this file was confirmed (during
  // authoring) to arrive too late to be seen by that already-created client.

  it('attaches the x-csrf-token header on a mutating request', async () => {
    await api.POST('/api/v1/auth/logout', { body: {}, fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.get('x-csrf-token')).toBe('test-csrf-token');
  });

  it('does not attach x-csrf-token on a GET request', async () => {
    await api.GET('/api/v1/users/me', { fetch: fetchMock });
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.get('x-csrf-token')).toBeNull();
  });

  it('calls the unauthorized handler on a 401 whose code is not refreshable', async () => {
    // AUTH_SESSION_REVOKED (a force-logout / password-change row_version
    // bump) is a 401 the silent-refresh middleware deliberately does not
    // try to fix (see client.ts's `REFRESHABLE_AUTH_CODES` comment) — it
    // should fall straight through to the unauthorized handler, same as
    // before this middleware existed.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'AUTH_SESSION_REVOKED', message: 'revoked' }), {
        status: 401,
      }),
    );
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await api.GET('/api/v1/users/me', { fetch: fetchMock });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not call the unauthorized handler for a 401 on the login route itself', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'AUTH_INVALID_CREDENTIALS', message: 'bad' }), {
        status: 401,
      }),
    );
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await api.POST('/api/v1/auth/login', {
      body: { email: 'a@example.com', password: 'x', device: { fingerprint: 'a'.repeat(20) } },
      fetch: fetchMock,
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

/** Defect C8 (this branch's P0 fix list): `sl_at` expires after 15
 * minutes and nothing ever called `POST /auth/refresh`, so every dashboard
 * session died at 15 minutes regardless of the 30-day `sl_rt` cookie. These
 * cover client.ts's fix: a 401 whose code means the access token is expired
 * or missing triggers one single-flighted refresh, then a single retry of
 * the original request. */
describe('api client silent token refresh', () => {
  afterEach(() => {
    setUnauthorizedHandler(() => {});
  });

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('refreshes once and retries the original request on AUTH_TOKEN_EXPIRED', async () => {
    let meCalls = 0;
    const fetchMock = vi.fn(async (input: Request) => {
      if (input.url.includes('/auth/refresh')) {
        return jsonResponse({ accessToken: 'a', refreshToken: 'b', expiresIn: 900 }, 200);
      }
      meCalls += 1;
      if (meCalls === 1) return jsonResponse({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401);
      return jsonResponse({ id: 'user-1' }, 200);
    });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const { data, error } = await api.GET('/api/v1/users/me', { fetch: fetchMock });

    expect(error).toBeUndefined();
    expect(data).toEqual({ id: 'user-1' });
    expect(meCalls).toBe(2);
    expect(handler).not.toHaveBeenCalled();
  });

  it('single-flights the refresh across two concurrent 401s and retries both', async () => {
    let refreshCalls = 0;
    const seenOnce = new Set<string>();
    const fetchMock = vi.fn(async (input: Request) => {
      if (input.url.includes('/auth/refresh')) {
        refreshCalls += 1;
        // Yield a tick so both callers' 401s are already awaiting this same
        // refresh before it resolves — proving they share one promise
        // rather than each independently calling in and racing.
        await Promise.resolve();
        return jsonResponse({ accessToken: 'a', refreshToken: 'b', expiresIn: 900 }, 200);
      }
      if (!seenOnce.has(input.url)) {
        seenOnce.add(input.url);
        return jsonResponse({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401);
      }
      return jsonResponse({ ok: true }, 200);
    });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const [a, b] = await Promise.all([
      api.GET('/api/v1/users/me', { fetch: fetchMock }),
      api.GET('/api/v1/analytics/me/overview', { fetch: fetchMock }),
    ]);

    expect(refreshCalls).toBe(1);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls the unauthorized handler with the original 401 when the refresh itself fails', async () => {
    const fetchMock = vi.fn(async (input: Request) => {
      if (input.url.includes('/auth/refresh')) {
        return jsonResponse({ code: 'AUTH_TOKEN_INVALID', message: 'no refresh token' }, 401);
      }
      return jsonResponse({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401);
    });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const { error } = await api.GET('/api/v1/users/me', { fetch: fetchMock });

    expect(handler).toHaveBeenCalledOnce();
    expect(error).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' });
  });

  it('never attempts a refresh for a 401 on /auth/refresh itself (no refresh loop)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401),
    );
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await api.POST('/api/v1/auth/refresh', { body: {}, fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it('never attempts a refresh for a 401 on /auth/login', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401),
    );
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await api.POST('/api/v1/auth/login', {
      body: { email: 'a@example.com', password: 'x', device: { fingerprint: 'a'.repeat(20) } },
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });
});
