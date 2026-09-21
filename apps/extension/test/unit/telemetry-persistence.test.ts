// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for defect #9 ("Defects found"): the telemetry queue
// used to be a bare module-level `let queue = emptyBatches()` — MV3
// service workers are killed for inactivity and restarted fresh on the
// next event with all in-memory state gone, so anything queued between
// `chrome.alarms` ticks was silently lost if the SW restarted before the
// next tick fired. `lib/telemetry.ts` now persists every enqueued item to
// `browser.storage.session` (falling back to `.local`) and re-hydrates
// from it on first use after a restart.
//
// A real SW restart can't be produced in a vitest/jsdom environment, but
// its defining, relevant property can: all of a module's own top-level
// state (its `let queue = ...`, its closures) is thrown away and
// re-initialised from scratch, while `chrome.storage.*` itself survives
// (session storage is *process*-scoped in real Chrome, not
// SW-instance-scoped — that's the whole reason it's the right place for
// this). `vi.resetModules()` + a fresh dynamic `import()` reproduces
// exactly that: a brand new module instance (fresh `queue`, fresh
// `hydration` promise, fresh `persistChain`) sharing the same
// `globalThis.chrome.storage` the "previous" module instance wrote to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type * as TelemetryModule from '../../src/lib/telemetry.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('lib/telemetry.ts: the queue survives a simulated service-worker restart (defect #9)', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Every test below does its own `vi.resetModules()` + re-import to
    // simulate a restart *within* the test — but without also resetting
    // here, the module cache would otherwise carry over *between* tests
    // (vitest module caching is per test-file, not per test), so the
    // "before" import at the start of one test could silently be the same
    // cached instance a previous test's "after" import left behind,
    // defeating the fresh-module-instance premise this whole suite relies
    // on.
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an item enqueued before the "restart" is still queued (pendingCount) after it, in a fresh module instance', async () => {
    const before = (await import('../../src/lib/telemetry.js')) as typeof TelemetryModule;
    before.enqueueActivity([{ type: 'search', occurredAt: new Date().toISOString(), metadata: {} }] as never);
    before.enqueueTrades([{ tradeId: 'restart-test-1', resourceId: 1, buyPrice: 100 }] as never);
    expect(before.pendingCount()).toBe(2);

    // Give the persist chain a chance to actually write to storage — this
    // is the exact window a real SW kill could land in too; the point of
    // this test is that *once persisted*, the data is safe, not that
    // persistence itself is instantaneous.
    await before.whenPersisted();

    // --- simulated SW restart: throw away every module's top-level state ---
    vi.resetModules();
    const after = (await import('../../src/lib/telemetry.js')) as typeof TelemetryModule;

    // The fresh instance starts with an empty in-memory queue...
    // ...but recovers the persisted items once hydration runs.
    await after.whenHydrated();
    expect(after.pendingCount()).toBe(2);
  });

  it('the recovered items are what a subsequent flush() actually sends — not just counted, genuinely recoverable', async () => {
    const before = (await import('../../src/lib/telemetry.js')) as typeof TelemetryModule;
    before.enqueueSniping([
      { resourceId: 7, targetPrice: 500, listedPrice: 480, outcome: 'success', latencyMs: 12, errorCode: null, occurredAt: new Date().toISOString() },
    ] as never);
    await before.whenPersisted();

    vi.resetModules();
    const after = (await import('../../src/lib/telemetry.js')) as typeof TelemetryModule;

    // Re-apply non-opted-out settings in the fresh module instance too —
    // settings.ts's own cache lives in storage.local, so it survives the
    // "restart" the same way, but this test only imported telemetry.ts, so
    // settings.ts hasn't been re-imported/re-seeded here; seed it directly.
    const settingsModule = await import('../../src/lib/settings.js');
    await settingsModule.applyServerSettings({ ...settingsModule.DEFAULT_SETTINGS, version: 1, telemetryOptOut: false });

    fetchMock.mockImplementation(async () => jsonResponse(200, { accepted: 1 }));

    const result = await after.flush();

    expect(result).toEqual({ ok: true, sent: 1 });
    const snipingCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/sniping/attempts'));
    expect(snipingCall).toBeDefined();
    expect(JSON.parse(String((snipingCall![1] as RequestInit).body))).toMatchObject({
      attempts: [expect.objectContaining({ resourceId: 7 })],
    });

    // And the persisted copy is now cleared, so a *second* restart doesn't
    // re-deliver the same, already-sent item again.
    await after.whenPersisted();
    vi.resetModules();
    const afterSecondRestart = (await import('../../src/lib/telemetry.js')) as typeof TelemetryModule;
    await afterSecondRestart.whenHydrated();
    expect(afterSecondRestart.pendingCount()).toBe(0);
  });

  it('items enqueued synchronously right after import are never clobbered by hydration merging in older persisted data', async () => {
    const before = (await import('../../src/lib/telemetry.js')) as typeof TelemetryModule;
    before.enqueueFilterStats([
      { filterId: 'restart-filter-1', windowStart: new Date().toISOString(), searches: 1, attempts: 1, successes: 1, coinsSpent: 100, coinsEarned: 150 },
    ] as never);
    await before.whenPersisted();

    vi.resetModules();
    const after = (await import('../../src/lib/telemetry.js')) as typeof TelemetryModule;
    // Enqueue immediately, synchronously, in the same tick as import —
    // before this test ever awaits hydration itself. This must not be
    // silently overwritten once hydration's own (later-resolving) merge
    // runs.
    after.enqueueRiskEvents([
      { kind: 'actions_per_hour', value: 1, threshold: 30, deviceId: 'd-1', sessionId: 's-1', occurredAt: new Date().toISOString() },
    ] as never);
    expect(after.pendingCount()).toBe(1); // the synchronous enqueue took effect immediately, unconditionally

    await after.whenHydrated();
    // Both the pre-restart persisted item (filterStats) and the
    // post-restart synchronous one (riskEvents) are present — additive
    // merge, not a clobber in either direction.
    expect(after.pendingCount()).toBe(2);
  });
});
