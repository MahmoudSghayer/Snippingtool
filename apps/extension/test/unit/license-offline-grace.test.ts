// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Unit coverage for lib/license.ts's offline-grace cache
// (checkOfflineGrace/verifyEntitlementBlob/bootstrap/heartbeat caching),
// previously untested.
//
// Testability note: this test file's `import.meta.env.VITE_LICENSE_PUBLIC_KEY`
// is `''` (apps/extension/vitest.config.ts's `define` block — not owned by
// this suite, and a Vite `define` is a compile-time literal substitution,
// not something a test can override per-file via `vi.stubEnv`). With no key
// configured, `verifyEntitlementBlob()` always returns `false` by its own
// documented contract ("no VITE_LICENSE_PUBLIC_KEY configured — ... cannot
// be verified", a loud warning rather than silently trusting an
// unverifiable blob) — so `checkOfflineGrace()`'s 24h-expiry branch
// (`verified === true` and the cache is/isn't older than 24h) cannot be
// exercised end-to-end from this package's test config as it stands. What
// *is* fully covered here: the "no cache" and "cache present but
// unverifiable" paths (both real, reachable outcomes — the latter being
// literally what a dev build without a configured signing key does today),
// `verifyEntitlementBlob`'s own contract in isolation (malformed blob, no
// key configured — both proven never to throw), and that `bootstrap()`/
// `heartbeat()` correctly stamp the cache's `cachedAt` (the clock the grace
// window is measured from) each time they're called. Exercising the actual
// expiry boundary end-to-end needs a real Ed25519 keypair wired through
// that `define` block — filed as a suggestion, not a defect, in
// docs/12-testing.md "Defects found" (production presumably configures a
// real key; only this test build's fixed empty default blocks it here).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootstrap, checkOfflineGrace, heartbeat, verifyEntitlementBlob } from '../../src/lib/license.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type { BootstrapResponse } from '@sl/shared';

function fakeBootstrapResponse(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    userId: 'user-1',
    subscription: { plan: 'pro', status: 'active', deviceLimit: 2, trialEndsAt: null, currentPeriodEnd: null },
    license: { key: null, maxDevices: 2, expiresAt: null },
    features: {},
    settings: {
      version: 1,
      targets: { minProfitPerSnipe: 500, dailyProfitGoal: null },
      budgets: { maxCoinsPerSnipe: 50_000, sessionCoinBudget: null },
      governor: { actionsPerHour: 30, sessionLengthMinutes: 90, buyToSearchRatio: 1, cooldownSeconds: 20, maxCoinFlowPerHour: 300_000 },
      telemetryOptOut: false,
      notifications: { email: true, push: false, killSwitch: true, subscriptionChanges: true, weeklyDigest: false },
    },
    killSwitchActive: false,
    entitlementBlob: 'not-a-real-signed-blob.deadbeef',
    deviceId: 'device-1',
    ...overrides,
  } as BootstrapResponse;
}

describe('lib/license.ts: offline-grace cache', () => {
  useRealChromeStorage();

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifyEntitlementBlob rejects a malformed blob (missing the payload.signature separator) without throwing', async () => {
    await expect(verifyEntitlementBlob('not-a-valid-blob')).resolves.toBe(false);
  });

  it('verifyEntitlementBlob returns false (never throws) when no public key is configured — the documented "cannot be verified, never silently trusted" contract', async () => {
    await expect(verifyEntitlementBlob('cGF5bG9hZA.c2ln')).resolves.toBe(false);
  });

  it('checkOfflineGrace with no cached entitlement at all reports no grace', async () => {
    const result = await checkOfflineGrace();
    expect(result).toEqual({ withinGrace: false, cached: null });
  });

  it('checkOfflineGrace with a cached-but-unverifiable entitlement (this build’s real current state) reports no grace, even seconds after caching', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fakeBootstrapResponse()), { status: 200, headers: { 'content-type': 'application/json' } }));

    await bootstrap();
    const result = await checkOfflineGrace(Date.now() + 1_000); // one second later — well within any real grace window
    expect(result.withinGrace).toBe(false); // blob doesn't verify -> never within grace, regardless of freshness
    expect(result.cached?.bootstrap.userId).toBe('user-1');
  });

  it('bootstrap() stamps the cache with the current time as cachedAt', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fakeBootstrapResponse()), { status: 200, headers: { 'content-type': 'application/json' } }));

    const before = Date.now();
    await bootstrap();
    const after = Date.now();

    const result = await checkOfflineGrace();
    expect(result.cached).not.toBeNull();
    expect(result.cached!.cachedAt).toBeGreaterThanOrEqual(before);
    expect(result.cached!.cachedAt).toBeLessThanOrEqual(after);
  });

  it('heartbeat() refreshes cachedAt to now and preserves the prior bootstrap’s userId', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fakeBootstrapResponse({ userId: 'user-42' })), { status: 200, headers: { 'content-type': 'application/json' } }));
    await bootstrap();

    const firstCache = (await checkOfflineGrace()).cached!;
    await new Promise((resolve) => setTimeout(resolve, 5));

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ subscription: fakeBootstrapResponse().subscription, license: fakeBootstrapResponse().license, features: {}, settings: fakeBootstrapResponse().settings, killSwitchActive: false, entitlementBlob: 'still-not-real.blob' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await heartbeat('device-1', 'idle');

    const secondCache = (await checkOfflineGrace()).cached!;
    expect(secondCache.cachedAt).toBeGreaterThan(firstCache.cachedAt);
    expect(secondCache.bootstrap.userId).toBe('user-42'); // preserved from the prior bootstrap, per heartbeat()'s own contract
  });

  it('heartbeat() returns null (never throws) on a network failure and leaves the prior cache untouched', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fakeBootstrapResponse()), { status: 200, headers: { 'content-type': 'application/json' } }));
    await bootstrap();
    const before = (await checkOfflineGrace()).cached!;

    // retryFetch retries a network failure up to 3 more times before giving
    // up — mockRejectedValue (not -Once) so every attempt sees the same
    // failure, matching a real sustained outage.
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await heartbeat('device-1', 'idle');
    expect(result).toBeNull();

    const after = (await checkOfflineGrace()).cached!;
    expect(after.cachedAt).toBe(before.cachedAt); // untouched — heartbeat() only caches on success
  }, 15_000);
});
