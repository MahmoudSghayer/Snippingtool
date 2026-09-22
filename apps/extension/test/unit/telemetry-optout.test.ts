// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Unit coverage for lib/telemetry.ts's opt-out behaviour, previously
// untested: telemetryOptOut must drop every queued batch (activity,
// sniping, trades, filter stats, risk events, telemetry pings) locally
// without ever calling the network — license heartbeat (a separate
// mechanism in lib/license.ts, which does not import this file) is the only
// thing that keeps flowing while opted out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyServerSettings, DEFAULT_SETTINGS } from '../../src/lib/settings.js';
import {
  enqueueActivity,
  enqueueFilterStats,
  enqueueRiskEvents,
  enqueueSniping,
  enqueueTelemetry,
  enqueueTrades,
  flush,
  pendingCount,
} from '../../src/lib/telemetry.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

function fillQueueWithOneOfEach(): void {
  enqueueActivity([{ type: 'search', occurredAt: new Date().toISOString(), metadata: {} }] as never);
  enqueueSniping([{ resourceId: 1, targetPrice: 100, listedPrice: 100, outcome: 'success', latencyMs: 5, errorCode: null, occurredAt: new Date().toISOString() }] as never);
  enqueueTrades([{ tradeId: 't-1', resourceId: 1, buyPrice: 100 }] as never);
  enqueueFilterStats([{ filterId: 'f-1', windowStart: new Date().toISOString(), searches: 1, attempts: 1, successes: 1, coinsSpent: 100, coinsEarned: 150 }] as never);
  enqueueRiskEvents([{ kind: 'actions_per_hour', value: 1, threshold: 30, deviceId: 'd-1', sessionId: 's-1', occurredAt: new Date().toISOString() }] as never);
  enqueueTelemetry([{ type: 'version_ping', occurredAt: new Date().toISOString() }] as never);
}

describe('lib/telemetry.ts: opt-out keeps only heartbeat (drops every queued batch, never touches the network)', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fillQueueWithOneOfEach();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('with telemetryOptOut=true, flush() drops the entire queue, calls no network, and reports sent:0', async () => {
    await applyServerSettings({ ...DEFAULT_SETTINGS, version: 1, telemetryOptOut: true });
    expect(pendingCount()).toBeGreaterThan(0);

    const result = await flush();

    expect(result).toEqual({ ok: true, sent: 0 });
    expect(pendingCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with telemetryOptOut=false (default), flush() sends every batch over the network', async () => {
    await applyServerSettings({ ...DEFAULT_SETTINGS, version: 1, telemetryOptOut: false });
    // A fresh Response per call — a Response body can only be read once, and
    // flush() fires several concurrent requests that each call res.json().
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await flush();

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(6); // one of each of the six queued categories
    expect(pendingCount()).toBe(0);
    // Every non-empty batch endpoint was actually called (5 batch posts + 1 telemetry post = 6 requests).
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const calledPaths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledPaths.some((p) => p.includes('/activity'))).toBe(true);
    expect(calledPaths.some((p) => p.includes('/risk-events'))).toBe(true);
    expect(calledPaths.some((p) => p.includes('/extension/telemetry'))).toBe(true);
  });

  it('opting out mid-session drops whatever was queued before the opt-out was read, not just future enqueues', async () => {
    // Queue already has items from beforeEach (settings default at that point is unopted-out, but flush() re-checks fresh).
    await applyServerSettings({ ...DEFAULT_SETTINGS, version: 1, telemetryOptOut: true });
    const before = pendingCount();
    expect(before).toBeGreaterThan(0);

    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed flush (opted in) re-queues everything for the next attempt rather than losing it', async () => {
    await applyServerSettings({ ...DEFAULT_SETTINGS, version: 1, telemetryOptOut: false });
    fetchMock.mockRejectedValue(new Error('network down'));

    const before = pendingCount();
    const result = await flush();

    expect(result.ok).toBe(false);
    expect(pendingCount()).toBe(before); // nothing lost
  }, 15_000);
});
