// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Unit coverage for lib/settings.ts's sync-conflict rule, previously
// untested: docs/06-extension.md documents "server version wins" — a local
// edit is only ever sent as a PUT (see defect #4's fix, docs/12-testing.md
// "Defects found"), never applied locally first, and whatever the server
// hands back (even a *lower* version, e.g. after an admin-triggered reset)
// unconditionally overwrites the local cache. There is deliberately no
// merge.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyServerSettings, DEFAULT_SETTINGS, getCachedSettings, refreshSettings, updateSettings } from '../../src/lib/settings.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type { UserSettings } from '@sl/shared';

function settingsAt(version: number, overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...DEFAULT_SETTINGS, version, ...overrides };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('lib/settings.ts: sync-conflict rule (server version always wins, no local merge)', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applyServerSettings unconditionally overwrites the local cache, even to a lower version than what was cached', async () => {
    await applyServerSettings(settingsAt(5, { targets: { minProfitPerSnipe: 999, dailyProfitGoal: null } }));
    expect((await getCachedSettings()).version).toBe(5);

    // An admin resets/lowers something server-side; the next sync hands back a *lower* version than the local cache.
    await applyServerSettings(settingsAt(2, { targets: { minProfitPerSnipe: 111, dailyProfitGoal: null } }));

    const cached = await getCachedSettings();
    expect(cached.version).toBe(2); // server's version wins outright — no "keep the higher version" logic
    expect(cached.targets.minProfitPerSnipe).toBe(111);
  });

  it('refreshSettings() replaces the cache with the server response, not a merge of local + server', async () => {
    await applyServerSettings(settingsAt(1, { budgets: { maxCoinsPerSnipe: 10_000, sessionCoinBudget: null } }));

    fetchMock.mockResolvedValueOnce(jsonResponse(settingsAt(7, { budgets: { maxCoinsPerSnipe: 999_999, sessionCoinBudget: 5_000_000 } })));

    const result = await refreshSettings();
    expect(result.version).toBe(7);
    expect(result.budgets).toEqual({ maxCoinsPerSnipe: 999_999, sessionCoinBudget: 5_000_000 });

    const cached = await getCachedSettings();
    expect(cached).toEqual(result); // cache now holds exactly the server's document, nothing locally blended in
  });

  it('refreshSettings() falls back to the existing cache (does not clear it) when the network call fails', async () => {
    await applyServerSettings(settingsAt(3, { targets: { minProfitPerSnipe: 42, dailyProfitGoal: null } }));
    fetchMock.mockRejectedValue(new Error('offline'));

    const result = await refreshSettings();
    expect(result.version).toBe(3);
    expect(result.targets.minProfitPerSnipe).toBe(42);
  }, 15_000);

  it('updateSettings() sends the local patch as a PATCH request but caches whatever the server returns, never the locally-optimistic merge', async () => {
    await applyServerSettings(settingsAt(1));

    // Server applies the patch differently than a naive local merge would (e.g. clamps to an admin ceiling) and bumps version.
    fetchMock.mockResolvedValueOnce(jsonResponse(settingsAt(2, { targets: { minProfitPerSnipe: 500, dailyProfitGoal: null } })));

    const result = await updateSettings({ targets: { minProfitPerSnipe: 999_999 } });

    // The server's clamped value is what's trusted and cached — not the 999999 the client optimistically asked for.
    expect(result.targets.minProfitPerSnipe).toBe(500);
    expect(result.version).toBe(2);
    expect((await getCachedSettings()).targets.minProfitPerSnipe).toBe(500);

    // The outgoing request itself carried the client's requested patch (server-side logic decided what to do with it).
    // Defect #4 (docs/12-testing.md "Defects found") is fixed: this now
    // asserts PUT, the verb apps/api/src/modules/settings/index.ts actually
    // registers for this route (it used to send PATCH, which 404d against
    // the real server — see apps/api/src/test/qa/__tests__/
    // settings-versioning.test.ts's now-passing "DEFECT" test).
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ targets: { minProfitPerSnipe: 999_999 } });
  });

  it('with no prior cache, getCachedSettings() returns the documented client-side defaults (version 0)', async () => {
    const cached = await getCachedSettings();
    expect(cached).toEqual(DEFAULT_SETTINGS);
    expect(cached.version).toBe(0);
  });
});
