// A browser restart clears `storage.session`, and with it the access token,
// while the encrypted refresh token in `storage.local` survives. Until P0
// Task 13, `isAuthenticated()` only looked at the access token, so after a
// restart the extension acted signed out (no entitlement, no engine) until
// the user signed in again. Now background tries one refresh at startup,
// and `isAuthenticated()` waits for it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRealChromeStorage } from './chrome-storage-stub.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('lib/auth.ts: one token refresh at startup', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules(); // a fresh service worker: nothing tried yet
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function restartedBrowserWithRefreshToken() {
    const storage = await import('../../src/lib/storage.js');
    await storage.setLocal('sl.refreshTokenEnc', await storage.encryptString('a-valid-refresh-token'));
    return import('../../src/lib/auth.js');
  }

  it('refreshes once, and the extension is signed in again', async () => {
    const auth = await restartedBrowserWithRefreshToken();
    fetchMock.mockImplementation(async () => jsonResponse(200, { accessToken: 'fresh', refreshToken: 'rotated' }));
    expect(await auth.isAuthenticated()).toBe(false); // before startup ran
    const pending = auth.refreshOnStartup();
    // A status check while the refresh is in flight waits for it.
    expect(await auth.isAuthenticated()).toBe(true);
    expect(await pending).toBe(true);
    await auth.refreshOnStartup();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v1/auth/refresh');
  });

  it('does nothing with no refresh token (never signed in)', async () => {
    const auth = await import('../../src/lib/auth.js');
    expect(await auth.refreshOnStartup()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when the access token is still there (a service worker wake, not a restart)', async () => {
    const storage = await import('../../src/lib/storage.js');
    await storage.setSession('sl.accessToken', 'still-valid');
    const auth = await restartedBrowserWithRefreshToken();
    expect(await auth.refreshOnStartup()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refresh that cannot reach the API leaves it signed out, without throwing', async () => {
    const auth = await restartedBrowserWithRefreshToken();
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await auth.refreshOnStartup()).toBe(false);
    expect(await auth.isAuthenticated()).toBe(false);
  });
});
