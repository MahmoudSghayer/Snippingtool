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

  it('calls the unauthorized handler on a 401 for a non-exempt path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }), {
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
