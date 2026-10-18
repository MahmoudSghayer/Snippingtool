// lib/auth.ts's refresh, against an API that rotates the refresh token on
// every use and treats a superseded one as stolen (apps/api, docs/04-auth.md
// §3). Two things used to sign the Nova AI bot out mid-session:
//
//  - every EA tab of the userscript build runs its own copy of the
//    background logic over shared storage, so two tabs could refresh with
//    the same token at once: reuse, session revoked;
//  - `retryFetch` resent the same refresh token after a 502 or a dropped
//    connection, although the first attempt may have reached the API and
//    rotated it.
//
// Now a refresh holds the `sl-auth-refresh` Web Lock, re-reads storage once
// it does (another tab may have refreshed meanwhile), and after an attempt
// with no usable answer checks storage before ever sending its token again.
// "Two tabs" here are two instances of lib/auth.ts (vi.resetModules) over
// one storage; the lock manager is a small in-memory stand-in for
// `navigator.locks`, which jsdom lacks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type * as AuthModuleNs from '../../src/lib/auth.js';

type AuthModule = typeof AuthModuleNs;

const FIRST_RT = 'rt-1';
const STALE_AT = 'at-stale';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `navigator.locks`, enough of it: exclusive, FIFO per name, and a
 * `signal` that gives up waiting (not holding). `hold` takes a lock until
 * the returned function is called, as something else in the origin would. */
function installLockManager(): { requests: string[]; hold: (name: string) => () => void } {
  const tails = new Map<string, Promise<void>>();
  const requests: string[] = [];
  function queue(name: string): { before: Promise<void>; release: () => void } {
    const before = tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    tails.set(
      name,
      before.then(() => held),
    );
    return { before, release };
  }
  const locks = {
    async request<T>(name: string, optionsOrCallback: { signal?: AbortSignal } | (() => Promise<T>), maybeCallback?: () => Promise<T>): Promise<T> {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const signal = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback.signal;
      requests.push(name);
      const { before, release } = queue(name);
      try {
        await (signal
          ? Promise.race([
              before,
              new Promise<never>((_, reject) => {
                if (signal.aborted) reject(signal.reason);
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              }),
            ])
          : before);
      } catch (err) {
        void before.then(release); // never granted: do not block those queued behind
        throw err;
      }
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  return {
    requests,
    hold: (name) => {
      const { release } = queue(name);
      return release;
    },
  };
}

function removeLockManager(): void {
  Reflect.deleteProperty(globalThis.navigator, 'locks');
}

/** A fresh copy of lib/auth.ts: one more tab (or the service worker). */
async function openTab(): Promise<AuthModule> {
  vi.resetModules();
  const auth = await import('../../src/lib/auth.js');
  auth.setRefreshRetryForTests({ budgetMs: 200, delay: () => 5 });
  return auth;
}

async function seed(accessToken: string | null, refreshToken: string): Promise<void> {
  const storage = await import('../../src/lib/storage.js');
  if (accessToken) await storage.setSession('sl.accessToken', accessToken);
  await storage.setLocal('sl.refreshTokenEnc', await storage.encryptString(refreshToken));
}

async function stored(): Promise<{ access: string | null; refresh: string | null }> {
  const storage = await import('../../src/lib/storage.js');
  const enc = await storage.getLocal<string | null>('sl.refreshTokenEnc', null);
  return {
    access: await storage.getSession<string | null>('sl.accessToken', null),
    refresh: enc ? await storage.decryptString(enc) : null,
  };
}

function presentedToken(init: RequestInit): string {
  return (JSON.parse(String(init.body)) as { refreshToken: string }).refreshToken;
}

describe('lib/auth.ts: one refresh at a time across tabs, never a blind resend', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    removeLockManager();
  });

  it('two tabs refreshing at the same moment make one API call, and both end up with the new tokens', async () => {
    const { requests } = installLockManager();
    await seed(STALE_AT, FIRST_RT);
    const tabA = await openTab();
    const tabB = await openTab();
    fetchMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(200, { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 900 });
    });

    const [a, b] = await Promise.all([tabA.handleUnauthorized(STALE_AT), tabB.handleUnauthorized(STALE_AT)]);

    expect([a, b]).toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toEqual(['sl-auth-refresh', 'sl-auth-refresh']);
    expect(await stored()).toEqual({ access: 'at-2', refresh: 'rt-2' });
  });

  it('a lock held far longer than any refresh (a hung request, or the page in the userscript build) delays a refresh, never blocks it', async () => {
    const { hold } = installLockManager();
    const releaseForeign = hold('sl-auth-refresh');
    await seed(STALE_AT, FIRST_RT);
    const tab = await openTab();
    tab.setRefreshRetryForTests({ budgetMs: 200, delay: () => 5, lockWaitMs: 30 });
    fetchMock.mockResolvedValue(jsonResponse(200, { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 900 }));
    expect(await tab.handleUnauthorized(STALE_AT)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual({ access: 'at-2', refresh: 'rt-2' });
    releaseForeign();
  });

  it('a tab that gets the lock after another tab refreshed picks the new tokens up instead of calling the API', async () => {
    installLockManager();
    await seed('at-2', 'rt-2'); // another tab refreshed after this one's 401
    const tab = await openTab();
    expect(await tab.handleUnauthorized(STALE_AT)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 502 after the API rotated the token: the retry is the lost-answer retry the API grants, never reuse', async () => {
    installLockManager();
    await seed(STALE_AT, FIRST_RT);
    const tab = await openTab();
    // The API's side (apps/api refresh): the first attempt rotates rt-1 to
    // rt-2 and its answer is lost; a retry with rt-1 inside the grace, with
    // rt-2 never used, gets a fresh pair; anything else would be reuse.
    const server = { current: FIRST_RT, rotatedFrom: null as string | null, reuse: 0 };
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const presented = presentedToken(init);
      if (presented === server.current && server.rotatedFrom === null) {
        server.rotatedFrom = presented;
        server.current = 'rt-2';
        return jsonResponse(502, { code: 'INTERNAL', message: 'Bad gateway' });
      }
      if (presented === server.rotatedFrom) {
        server.current = 'rt-3';
        server.rotatedFrom = 'done';
        return jsonResponse(200, { accessToken: 'at-3', refreshToken: 'rt-3', expiresIn: 900 });
      }
      server.reuse += 1;
      return jsonResponse(401, { code: 'AUTH_TOKEN_REUSED', message: 'reuse' });
    });

    expect(await tab.handleUnauthorized(STALE_AT)).toBe(true);
    expect(server.reuse).toBe(0);
    expect(fetchMock.mock.calls.map(([, init]) => presentedToken(init as RequestInit))).toEqual([FIRST_RT, FIRST_RT]);
    expect(await stored()).toEqual({ access: 'at-3', refresh: 'rt-3' });
  });

  it('after an attempt with no answer, tokens another tab stored meanwhile are used: the old token is never sent again', async () => {
    await seed(STALE_AT, FIRST_RT);
    const tab = await openTab();
    fetchMock.mockImplementation(async () => {
      // While this tab's request is out, another tab (no Web Locks in this
      // browser) refreshes and stores its answer; this one's is lost.
      await seed('at-other', 'rt-other');
      throw new TypeError('Failed to fetch');
    });

    expect(await tab.handleUnauthorized(STALE_AT)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual({ access: 'at-other', refresh: 'rt-other' });
  });

  it('a refusal after another tab already refreshed does not clear that tab’s tokens', async () => {
    await seed(STALE_AT, FIRST_RT);
    const tab = await openTab();
    fetchMock.mockImplementation(async () => {
      await seed('at-other', 'rt-other');
      return jsonResponse(401, { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' });
    });
    expect(await tab.handleUnauthorized(STALE_AT)).toBe(true);
    expect(await stored()).toEqual({ access: 'at-other', refresh: 'rt-other' });
  });

  it('409 (another request rotated it at that moment): re-reads, then retries, and nothing is lost', async () => {
    await seed(STALE_AT, FIRST_RT);
    const tab = await openTab();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, { code: 'AUTH_REFRESH_CONFLICT', message: 'conflict' }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 900 }));
    expect(await tab.handleUnauthorized(STALE_AT)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await stored()).toEqual({ access: 'at-2', refresh: 'rt-2' });
  });

  it('an API that stays down (5xx, network) keeps the tokens and reports it unreachable, never signed out', async () => {
    await seed(STALE_AT, FIRST_RT);
    const tab = await openTab();
    fetchMock.mockResolvedValue(jsonResponse(502, { code: 'INTERNAL', message: 'Bad gateway' }));
    await expect(tab.handleUnauthorized(STALE_AT)).rejects.toMatchObject({ name: 'ApiError', status: 502 });
    expect(await stored()).toEqual({ access: STALE_AT, refresh: FIRST_RT });
    expect(await tab.hasAccount()).toBe(true);

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(tab.handleUnauthorized(STALE_AT)).rejects.toMatchObject({ name: 'NetworkError' });
    expect(await tab.hasAccount()).toBe(true);
  });

  it('a refused refresh signs out and remembers why: the password changed', async () => {
    await seed(STALE_AT, FIRST_RT);
    const tab = await openTab();
    fetchMock.mockResolvedValue(
      jsonResponse(401, { code: 'AUTH_TOKEN_REUSED', message: 'reuse', details: { reason: 'password_changed' } }),
    );
    expect(await tab.handleUnauthorized(STALE_AT)).toBe(false);
    expect(await stored()).toEqual({ access: null, refresh: null });
    expect(await tab.hasAccount()).toBe(false);
    expect((await tab.lastSignOut())?.reason).toBe('password_changed');

    // What content's entitlement check reads (`auth.status`).
    const { handleAuthStatus } = await import('../../src/background/auth.js');
    expect(await handleAuthStatus()).toEqual({ authenticated: false, hasAccount: false, signedOutReason: 'password_changed' });
  });

  it('auth.status: signed in while the account merely cannot be reached', async () => {
    await seed(null, FIRST_RT); // a browser restart whose startup refresh found no API
    await openTab();
    const { handleAuthStatus } = await import('../../src/background/auth.js');
    expect(await handleAuthStatus()).toEqual({ authenticated: false, hasAccount: true });
  });

  it('any other refusal is a session that ended', async () => {
    await seed(STALE_AT, FIRST_RT);
    const tab = await openTab();
    fetchMock.mockResolvedValue(jsonResponse(401, { code: 'AUTH_SESSION_REVOKED', message: 'revoked' }));
    expect(await tab.handleUnauthorized(STALE_AT)).toBe(false);
    expect((await tab.lastSignOut())?.reason).toBe('session_ended');
  });
});
