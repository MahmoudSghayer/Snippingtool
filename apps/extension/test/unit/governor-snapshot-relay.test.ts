// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for the popup live risk gauge (docs/10-design-system.md
// §15's former "Known gap", docs/12-testing.md "Defects found"): the popup
// previously always showed a static "tracked live on the EA page" message,
// never real numbers, because nothing relayed the governor's live snapshot
// from the content script (the only place it runs) to the popup.
// `background/governor.ts` now caches whatever `content/index.ts` last
// pushed (`handleGovernorSnapshotPush`) and hands it to the popup on
// request (`handleGovernorSnapshotGet`), with an honest `null` fallback
// when nothing was pushed recently — this exercises that relay directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleGovernorSnapshotGet, handleGovernorSnapshotPush } from '../../src/background/governor.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type { ExtGovernorSnapshotPushPayload } from '@sl/shared';

function sampleSnapshot(overrides: Partial<ExtGovernorSnapshotPushPayload> = {}): ExtGovernorSnapshotPushPayload {
  return {
    actionsLastHour: 12,
    actionsPerHourLimit: 30,
    sessionElapsedMinutes: 15,
    sessionLengthLimitMinutes: 90,
    buyToSearchRatio: 0.2,
    buyToSearchRatioLimit: 0.35,
    coinFlowLastHour: 45_000,
    coinFlowLimit: 300_000,
    inCooldown: false,
    cooldownRemainingMs: 0,
    killSwitchActive: false,
    ...overrides,
  };
}

describe('background/governor.ts: content -> background -> popup risk-snapshot relay', () => {
  useRealChromeStorage();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('with nothing ever pushed, get() returns null (honest "no live EA tab" fallback)', async () => {
    expect(await handleGovernorSnapshotGet()).toBeNull();
  });

  it('a pushed snapshot is returned by a subsequent get(), byte-for-byte (never recomputed)', async () => {
    const snapshot = sampleSnapshot({ actionsLastHour: 7, buyToSearchRatio: 0.31 });

    const pushResult = await handleGovernorSnapshotPush(snapshot);
    expect(pushResult).toEqual({ ok: true });

    const got = await handleGovernorSnapshotGet();
    expect(got).toEqual(snapshot);
  });

  it('a later push overwrites the cached snapshot (popup always sees the latest tick, not a stale one)', async () => {
    await handleGovernorSnapshotPush(sampleSnapshot({ actionsLastHour: 1 }));
    await handleGovernorSnapshotPush(sampleSnapshot({ actionsLastHour: 20 }));

    const got = await handleGovernorSnapshotGet();
    expect(got?.actionsLastHour).toBe(20);
  });

  it('a stale cached snapshot (no push in a while — the EA tab is gone) is not returned', async () => {
    await handleGovernorSnapshotPush(sampleSnapshot());
    expect(await handleGovernorSnapshotGet()).not.toBeNull();

    // Advance well past the staleness window (content/index.ts pushes
    // every 3s — 10s+ with no push means that tab is no longer reporting).
    vi.advanceTimersByTime(15_000);

    expect(await handleGovernorSnapshotGet()).toBeNull();
  });

  it('a fresh push after staleness makes it live again', async () => {
    await handleGovernorSnapshotPush(sampleSnapshot({ actionsLastHour: 3 }));
    vi.advanceTimersByTime(15_000);
    expect(await handleGovernorSnapshotGet()).toBeNull();

    await handleGovernorSnapshotPush(sampleSnapshot({ actionsLastHour: 9 }));
    const got = await handleGovernorSnapshotGet();
    expect(got?.actionsLastHour).toBe(9);
  });
});
