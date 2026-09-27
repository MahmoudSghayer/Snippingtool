// background/license.ts + background/kill-switch.ts over the signed cache
// (defect C11). `handleLicenseBootstrap` used to hand back whatever sat in
// `storage.local` for 10 minutes after its (editable) `cachedAt`, and never
// called `checkOfflineGrace`; `handleKillSwitchGet` read the cached
// `killSwitchActive` as-is. Now both read only verified claims, the offline
// grace is honoured when the API is unreachable, and the kill switch is never
// taken as "off" from anything unsigned.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/auth.js', () => ({
  isAuthenticated: vi.fn(async () => true),
  getValidAccessToken: vi.fn(async () => 'access-token'),
  handleUnauthorized: vi.fn(async () => false),
}));

import { handleKillSwitchGet } from '../../src/background/kill-switch.js';
import { handleLicenseBootstrap } from '../../src/background/license.js';
import * as auth from '../../src/lib/auth.js';
import { bootstrap, heartbeat } from '../../src/lib/license.js';
import { removeLocal, setLocal } from '../../src/lib/storage.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';
import { API_SIGNED_IAT, API_SIGNED_LEGACY_BLOB, claimsFor, FIXTURE_DEVICE_ID, FIXTURE_USER_ID, signBlob } from './license-test-keys.js';

import type { BootstrapResponse } from '@sl/shared';

const CACHE_KEY = 'sl.license.cache.v1';
const HOUR = 60 * 60 * 1000;
const IAT_MS = API_SIGNED_IAT * 1000;

function cachedResponse(overrides: Partial<BootstrapResponse>): BootstrapResponse {
  return {
    userId: FIXTURE_USER_ID,
    email: 'user@example.com',
    deviceId: FIXTURE_DEVICE_ID,
    subscription: null,
    license: null,
    features: [],
    settings: {
      version: 1,
      targets: { minProfitPerSnipe: 500, dailyProfitGoal: null },
      budgets: { maxCoinsPerSnipe: 50_000, sessionCoinBudget: null },
      governor: { actionsPerHour: 30, sessionLengthMinutes: 90, buyToSearchRatio: 1, cooldownSeconds: 20, maxCoinFlowPerHour: 300_000 },
      telemetryOptOut: false,
      notifications: { email: true, push: false, killSwitch: true, subscriptionChanges: true, weeklyDigest: false },
    },
    killSwitchActive: false,
    entitlementBlob: '',
    serverTime: new Date(IAT_MS).toISOString(),
    ...overrides,
  } as BootstrapResponse;
}

async function cacheSigned(features: string[], killSwitchActive: boolean | undefined, cachedAt: number, tamper: Partial<BootstrapResponse> = {}) {
  const entitlementBlob = await signBlob(claimsFor({ features, killSwitchActive, iat: API_SIGNED_IAT }));
  await setLocal(CACHE_KEY, { bootstrap: cachedResponse({ entitlementBlob, ...tamper }), cachedAt });
}

describe('background: licence answers from the verified cache', () => {
  useRealChromeStorage();
  beforeEach(() => removeLocal(CACHE_KEY)); // the stub's storage lives for the whole describe

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(auth.isAuthenticated).mockResolvedValue(true);
    // The API is unreachable for every test here unless a test says otherwise.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a fresh-looking cache with tampered fields is answered from the signed claims', async () => {
    vi.setSystemTime(IAT_MS + 60_000);
    await cacheSigned(['assist.ranker'], true, IAT_MS + 60_000, { features: ['assist.ranker', 'automation.autobuyer'], killSwitchActive: false });

    const result = await handleLicenseBootstrap();
    expect(result!.features).toEqual(['assist.ranker']);
    expect(result!.killSwitchActive).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled(); // fresh cache, no network
  });

  // The signed-in user's own email (bootstrap only) survives the whole trip:
  // API bootstrap -> storage.local cache -> verified cache read -> the
  // `license.bootstrap` answer, and a heartbeat (which carries no email)
  // rewriting the cache in between.
  it("the account email survives bootstrap -> cache -> read, and a heartbeat's cache rewrite", async () => {
    vi.setSystemTime(IAT_MS + 60_000);
    const entitlementBlob = await signBlob(claimsFor({ features: ['assist.ranker'], killSwitchActive: false, iat: API_SIGNED_IAT }));
    const live = cachedResponse({ entitlementBlob, email: 'me@example.com' });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(json(live));
    expect((await bootstrap()).email).toBe('me@example.com');
    expect((await handleLicenseBootstrap())!.email).toBe('me@example.com');

    const { userId: _u, email: _e, ...hb } = live;
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(json(hb));
    expect(await heartbeat(FIXTURE_DEVICE_ID, 'idle')).not.toBeNull();

    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls.length;
    const result = await handleLicenseBootstrap();
    expect(result!.email).toBe('me@example.com');
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(fetchCalls); // answered from the cache
  });

  it('API unreachable: a valid blob is honoured within the 24h grace', async () => {
    vi.setSystemTime(IAT_MS + 3 * HOUR);
    await cacheSigned(['assist.ranker', 'automation.autobuyer'], false, IAT_MS);

    const result = await handleLicenseBootstrap();
    expect(result).not.toBeNull();
    expect(result!.features).toEqual(['assist.ranker', 'automation.autobuyer']);
    expect(result!.killSwitchActive).toBe(false);
  }, 15_000);

  it('API unreachable past the grace: paid features switch off, the signed kill switch still holds', async () => {
    vi.setSystemTime(IAT_MS + 25 * HOUR); // past 24h grace, inside the blob's 26h expiry
    await cacheSigned(['assist.ranker', 'automation.autobuyer'], true, IAT_MS + 25 * HOUR - 60_000);

    const result = await handleLicenseBootstrap();
    expect(result).not.toBeNull();
    expect(result!.features).toEqual([]);
    expect(result!.killSwitchActive).toBe(true);
  }, 15_000);

  it('API unreachable with a future-stamped cache: nothing is granted', async () => {
    vi.setSystemTime(IAT_MS + HOUR);
    await cacheSigned(['automation.autobuyer'], false, IAT_MS + 48 * HOUR);

    expect(await handleLicenseBootstrap()).toBeNull();
  }, 15_000);

  it('a local failure after the API answered is not "offline": no grace', async () => {
    vi.setSystemTime(IAT_MS + 3 * HOUR);
    await cacheSigned(['automation.autobuyer'], false, IAT_MS);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('<html>not json</html>', { status: 200 }));

    expect(await handleLicenseBootstrap()).toBeNull();
  });

  it('the API refusing (403) is not "offline": no grace', async () => {
    vi.setSystemTime(IAT_MS + 3 * HOUR);
    await cacheSigned(['automation.autobuyer'], false, IAT_MS);
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response(JSON.stringify({ error: { code: 'DEVICE_REVOKED', message: 'no' } }), { status: 403, headers: { 'content-type': 'application/json' } }),
    );

    expect(await handleLicenseBootstrap()).toBeNull();
  });
});

describe('background: kill-switch pull never trusts an unsigned "off"', () => {
  useRealChromeStorage();
  beforeEach(() => removeLocal(CACHE_KEY)); // the stub's storage lives for the whole describe

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(IAT_MS + HOUR);
    vi.mocked(auth.isAuthenticated).mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('follows the signed claim over the cached field', async () => {
    await cacheSigned(['assist.ranker'], true, IAT_MS, { killSwitchActive: false });
    expect((await handleKillSwitchGet()).active).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('a signed "off" within grace holds while the live endpoint is rate-limited: no false halt', async () => {
    await cacheSigned(['assist.ranker'], false, IAT_MS);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}', { status: 429 }));

    expect(await handleKillSwitchGet()).toEqual({ active: false });
    expect(globalThis.fetch).not.toHaveBeenCalled(); // a signed claim is never second-guessed by a poll
  });

  it('a tampered cache, API unreachable: fails closed', async () => {
    await cacheSigned(['assist.ranker'], true, IAT_MS, { killSwitchActive: false });
    const raw = (await import('../../src/lib/license.js')).readUnverifiedCache;
    const entry = (await raw())!;
    // Flip one signature character (the first, whose bits all count).
    const blob = entry.bootstrap.entitlementBlob;
    const at = blob.lastIndexOf('.') + 1;
    entry.bootstrap.entitlementBlob = blob.slice(0, at) + (blob[at] === 'A' ? 'B' : 'A') + blob.slice(at + 1);
    await setLocal(CACHE_KEY, entry);

    const pulled = await handleKillSwitchGet();
    expect(pulled.active).toBe(true);
    expect(pulled.reason).toBeTruthy();
  });

  it('a legacy blob without the claim asks GET /extension/kill-switch, and fails closed if it cannot', async () => {
    await setLocal(CACHE_KEY, { bootstrap: cachedResponse({ entitlementBlob: API_SIGNED_LEGACY_BLOB, killSwitchActive: false }), cachedAt: IAT_MS });
    expect((await handleKillSwitchGet()).active).toBe(true);

    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      expect(String(input)).toMatch(/\/api\/v1\/extension\/kill-switch$/);
      return new Response(JSON.stringify({ active: false }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(await handleKillSwitchGet()).toEqual({ active: false });
  });

  it('signed out with no cache: inactive, no network', async () => {
    vi.mocked(auth.isAuthenticated).mockResolvedValue(false);
    expect(await handleKillSwitchGet()).toEqual({ active: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
