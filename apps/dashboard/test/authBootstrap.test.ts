import { afterEach, describe, expect, it, vi } from 'vitest';

/** Defect C8 (this branch's P0 fix list): the page-load session
 * bootstrap (`ensureBootstrapped`) treated any `GET /users/me` failure as
 * "logged out", including a 401 caused only by `sl_at` having expired one
 * second earlier — which happened to every user within 15 minutes, since
 * nothing ever refreshed it. The fix lives entirely in api/client.ts's
 * middleware (test/apiClient.test.ts covers it directly); this file proves
 * `ensureBootstrapped` benefits from it for free, since it calls `api.GET`
 * like any other call site.
 *
 * `api` is a module-level singleton that binds `globalThis.fetch` once, at
 * import time (see test/apiClient.test.ts's note on this) — so unlike that
 * file, this one can't pass a per-call `fetch` override (`ensureBootstrapped`
 * doesn't expose one, by design: it's not itself aware of the refresh
 * mechanism). Instead each test stubs `globalThis.fetch` *before* resetting
 * the module registry and re-importing, so the freshly-constructed `api`
 * binds the stub. */
describe('ensureBootstrapped', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('tries a refresh before treating a 401 on /users/me as logged out', async () => {
    let meCalls = 0;
    const fetchMock = vi.fn(async (input: Request) => {
      if (input.url.includes('/auth/refresh')) {
        return jsonResponse({ accessToken: 'a', refreshToken: 'b', expiresIn: 900 }, 200);
      }
      meCalls += 1;
      if (meCalls === 1)
        return jsonResponse({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401);
      return jsonResponse({ id: 'user-1', role: 'user', permissions: [] }, 200);
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const { ensureBootstrapped } = await import('@/lib/authBootstrap.js');
    const { useAuthStore } = await import('@/stores/auth.js');

    await ensureBootstrapped();

    expect(meCalls).toBe(2);
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('still logs out when /users/me 401s and the refresh also fails', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 'AUTH_TOKEN_EXPIRED', message: 'expired' }, 401),
    );

    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const { ensureBootstrapped } = await import('@/lib/authBootstrap.js');
    const { useAuthStore } = await import('@/stores/auth.js');

    await ensureBootstrapped();

    expect(useAuthStore.getState().status).toBe('anonymous');
  });
});
