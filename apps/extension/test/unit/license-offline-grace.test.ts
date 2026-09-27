// lib/license.ts: the signed entitlement cache and the 24h offline grace.
//
// Defect C11 (P0): the cache in `storage.local` was trusted on read without
// any verification, and the blob parser split jose's three-part compact JWS
// as `payload.signature`, so even a genuine blob never verified. Anyone could
// edit the cache to add `automation.autobuyer`, clear `killSwitchActive`,
// push `cachedAt` into the future and block the API. These tests pin the
// fix: the blob is verified on every cache read, and features, the kill
// switch and expiry come only from its signed claims.
//
// The build's public key here is a test key (vitest.config.ts), and the
// fixtures in ./license-test-keys.ts were signed by the API's own signer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrap,
  checkOfflineGrace,
  getCachedEntitlement,
  heartbeat,
  readUnverifiedCache,
  verifyEntitlementBlob,
  verifyEntitlementClaims,
} from '../../src/lib/license.js';
import { removeLocal, setLocal } from '../../src/lib/storage.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';
import {
  API_SIGNED_BLOB,
  API_SIGNED_EXP,
  API_SIGNED_IAT,
  API_SIGNED_LEGACY_BLOB,
  b64urlJson,
  claimsFor,
  FIXTURE_DEVICE_ID,
  FIXTURE_USER_ID,
  signBlob,
} from './license-test-keys.js';

import type { BootstrapResponse } from '@sl/shared';

const CACHE_KEY = 'sl.license.cache.v1';
const HOUR = 60 * 60 * 1000;
const IAT_MS = API_SIGNED_IAT * 1000;

function fakeBootstrapResponse(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    userId: FIXTURE_USER_ID,
    deviceId: FIXTURE_DEVICE_ID,
    subscription: null,
    license: null,
    features: ['assist.ranker'],
    settings: {
      version: 1,
      targets: { minProfitPerSnipe: 500, dailyProfitGoal: null },
      budgets: { maxCoinsPerSnipe: 50_000, sessionCoinBudget: null },
      governor: { actionsPerHour: 30, sessionLengthMinutes: 90, buyToSearchRatio: 1, cooldownSeconds: 20, maxCoinFlowPerHour: 300_000 },
      telemetryOptOut: false,
      notifications: { email: true, push: false, killSwitch: true, subscriptionChanges: true, weeklyDigest: false },
    },
    killSwitchActive: false,
    entitlementBlob: API_SIGNED_BLOB,
    serverTime: new Date(IAT_MS).toISOString(),
    ...overrides,
  } as BootstrapResponse;
}

async function writeCache(bootstrapResponse: BootstrapResponse, cachedAt: number): Promise<void> {
  await setLocal(CACHE_KEY, { bootstrap: bootstrapResponse, cachedAt });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('lib/license.ts: verifying the entitlement blob', () => {
  it('verifies a blob signed by the API (jose compact JWS, three parts) and returns its claims', async () => {
    const claims = await verifyEntitlementClaims(API_SIGNED_BLOB, IAT_MS + HOUR);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(FIXTURE_USER_ID);
    expect(claims!.deviceId).toBe(FIXTURE_DEVICE_ID);
    expect(claims!.killSwitchActive).toBe(false);
    expect(claims!.snapshot.features).toEqual(['assist.ranker']);
    await expect(verifyEntitlementBlob(API_SIGNED_BLOB, IAT_MS + HOUR)).resolves.toBe(true);
  });

  it('verifies a legacy API blob with no kill-switch claim, leaving the claim undefined', async () => {
    const claims = await verifyEntitlementClaims(API_SIGNED_LEGACY_BLOB, IAT_MS + HOUR);
    expect(claims).not.toBeNull();
    expect(claims!.killSwitchActive).toBeUndefined();
  });

  it('rejects the blob once its signed expiry has passed', async () => {
    await expect(verifyEntitlementClaims(API_SIGNED_BLOB, API_SIGNED_EXP * 1000 + 1)).resolves.toBeNull();
  });

  it('rejects a blob issued more than 5 minutes after now (clock rolled back), and allows ordinary skew', async () => {
    await expect(verifyEntitlementClaims(API_SIGNED_BLOB, IAT_MS - 6 * 60 * 1000)).resolves.toBeNull();
    await expect(verifyEntitlementClaims(API_SIGNED_BLOB, IAT_MS - 4 * 60 * 1000)).resolves.not.toBeNull();
  });

  it('rejects claims edited after signing (features added, signature kept)', async () => {
    const [header, , sig] = API_SIGNED_BLOB.split('.');
    const forged = claimsFor({ features: ['assist.ranker', 'automation.autobuyer'], killSwitchActive: false, iat: API_SIGNED_IAT, exp: API_SIGNED_EXP });
    await expect(verifyEntitlementClaims(`${header}.${b64urlJson(forged)}.${sig}`, IAT_MS + HOUR)).resolves.toBeNull();
  });

  it('rejects a blob signed by any key other than the one built in', async () => {
    const forger = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const blob = await signBlob(claimsFor({ features: ['automation.autobuyer'], killSwitchActive: false, iat: API_SIGNED_IAT }), forger.privateKey);
    await expect(verifyEntitlementClaims(blob, IAT_MS + HOUR)).resolves.toBeNull();
  });

  it('rejects malformed blobs without throwing, including the old two-part guess and the unsigned dev blob', async () => {
    const [, payload, sig] = API_SIGNED_BLOB.split('.');
    for (const blob of ['not-a-valid-blob', `${payload}.${sig}`, b64urlJson({ unsigned: true }), '..', `${b64urlJson({ alg: 'none' })}.${payload}.`]) {
      await expect(verifyEntitlementClaims(blob, IAT_MS + HOUR)).resolves.toBeNull();
    }
  });
});

describe('lib/license.ts: reading the cache', () => {
  useRealChromeStorage();
  beforeEach(() => removeLocal(CACHE_KEY)); // the stub's storage lives for the whole describe

  it('takes features and the kill switch from the signed claims, not the editable cached fields', async () => {
    const blob = await signBlob(claimsFor({ features: ['assist.ranker'], killSwitchActive: true, iat: API_SIGNED_IAT }));
    await writeCache(fakeBootstrapResponse({ entitlementBlob: blob, features: ['assist.ranker', 'automation.autobuyer'], killSwitchActive: false }), IAT_MS);

    const cached = await getCachedEntitlement(IAT_MS + HOUR);
    expect(cached).not.toBeNull();
    expect(cached!.bootstrap.features).toEqual(['assist.ranker']);
    expect(cached!.bootstrap.killSwitchActive).toBe(true);
    expect(cached!.killSwitchSigned).toBe(true);
  });

  it('drops a feature key the build does not know instead of passing it through', async () => {
    const blob = await signBlob(claimsFor({ features: ['assist.ranker', 'future.thing'], killSwitchActive: false, iat: API_SIGNED_IAT }));
    await writeCache(fakeBootstrapResponse({ entitlementBlob: blob }), IAT_MS);
    expect((await getCachedEntitlement(IAT_MS + HOUR))!.bootstrap.features).toEqual(['assist.ranker']);
  });

  it('rejects a cache whose blob was tampered with', async () => {
    const [header, , sig] = API_SIGNED_BLOB.split('.');
    const forged = claimsFor({ features: ['automation.autobuyer'], killSwitchActive: false, iat: API_SIGNED_IAT, exp: API_SIGNED_EXP });
    await writeCache(fakeBootstrapResponse({ entitlementBlob: `${header}.${b64urlJson(forged)}.${sig}` }), IAT_MS);

    expect(await getCachedEntitlement(IAT_MS + HOUR)).toBeNull();
    expect((await checkOfflineGrace(IAT_MS + HOUR)).withinGrace).toBe(false);
  });

  it('rejects a cache stamped more than 5 minutes in the future, and allows ordinary clock skew', async () => {
    await writeCache(fakeBootstrapResponse(), IAT_MS + 6 * 60 * 1000);
    expect(await getCachedEntitlement(IAT_MS)).toBeNull();
    expect((await checkOfflineGrace(IAT_MS)).withinGrace).toBe(false);

    await writeCache(fakeBootstrapResponse(), IAT_MS + 4 * 60 * 1000);
    expect(await getCachedEntitlement(IAT_MS)).not.toBeNull();
  });

  it('reports a legacy blob’s kill switch as unsigned rather than trusting the cached "false"', async () => {
    await writeCache(fakeBootstrapResponse({ entitlementBlob: API_SIGNED_LEGACY_BLOB, killSwitchActive: false }), IAT_MS);
    const cached = await getCachedEntitlement(IAT_MS + HOUR);
    expect(cached).not.toBeNull();
    expect(cached!.killSwitchSigned).toBe(false);
    expect(cached!.bootstrap.killSwitchActive).toBe(true); // fail closed until someone asks the API
  });
});

describe('lib/license.ts: offline grace', () => {
  useRealChromeStorage();
  beforeEach(() => removeLocal(CACHE_KEY)); // the stub's storage lives for the whole describe

  it('accepts a valid blob offline within the 24h grace', async () => {
    await writeCache(fakeBootstrapResponse(), IAT_MS);
    const result = await checkOfflineGrace(IAT_MS + 23 * HOUR);
    expect(result.withinGrace).toBe(true);
    expect(result.cached!.bootstrap.features).toEqual(['assist.ranker']);
  });

  it('ends the grace 24h after the blob was signed, even if cachedAt is pushed forward', async () => {
    // The blob itself is still inside its 26h signed expiry, so it verifies
    // (and its kill switch still counts); only the grace is over.
    await writeCache(fakeBootstrapResponse(), IAT_MS + 24.5 * HOUR);
    const result = await checkOfflineGrace(IAT_MS + 25 * HOUR);
    expect(result.cached).not.toBeNull();
    expect(result.withinGrace).toBe(false);
  });

  it('reports no grace with no cache at all', async () => {
    expect(await checkOfflineGrace()).toEqual({ withinGrace: false, cached: null });
  });
});

describe('lib/license.ts: bootstrap/heartbeat caching', () => {
  useRealChromeStorage();
  beforeEach(() => removeLocal(CACHE_KEY)); // the stub's storage lives for the whole describe

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bootstrap() stamps the cache with the current time as cachedAt', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(fakeBootstrapResponse()));

    const before = Date.now();
    await bootstrap();
    const after = Date.now();

    const raw = await readUnverifiedCache();
    expect(raw!.cachedAt).toBeGreaterThanOrEqual(before);
    expect(raw!.cachedAt).toBeLessThanOrEqual(after);
  });

  it('heartbeat() refreshes cachedAt to now and preserves the prior bootstrap’s userId', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(fakeBootstrapResponse({ userId: 'user-42' })));
    await bootstrap();
    const first = (await readUnverifiedCache())!;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const { userId: _drop, ...hb } = fakeBootstrapResponse();
    fetchMock.mockResolvedValueOnce(jsonResponse(hb));
    await heartbeat('device-1', 'idle');

    const second = (await readUnverifiedCache())!;
    expect(second.cachedAt).toBeGreaterThan(first.cachedAt);
    expect(second.bootstrap.userId).toBe('user-42');
  });

  it('heartbeat() returns null (never throws) on a network failure and leaves the prior cache untouched', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(fakeBootstrapResponse()));
    await bootstrap();
    const before = (await readUnverifiedCache())!;

    // retryFetch retries a network failure up to 3 more times before giving
    // up, so every attempt sees the same failure, like a real outage.
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await heartbeat('device-1', 'idle')).toBeNull();
    expect((await readUnverifiedCache())!.cachedAt).toBe(before.cachedAt);
  }, 15_000);
});
