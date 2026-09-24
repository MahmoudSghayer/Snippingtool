// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for the bug fixed alongside this test: `flush()` used
// to fire its six batch POSTs with `Promise.all`, so one rejected request
// threw before the other five settled results could be inspected, and the
// single top-level `catch` re-queued *all six* batches — including the ones
// that had already gotten a 2xx from the API. The next alarm tick then
// re-sent those already-accepted batches, and the API recorded duplicates.
//
// `flush()` now uses `Promise.allSettled` and only re-queues the batch(es)
// whose own POST actually failed.

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fillQueueWithOneOfEach(): void {
  enqueueActivity([{ type: 'search', occurredAt: new Date().toISOString(), metadata: {} }] as never);
  enqueueSniping([{ resourceId: 1, targetPrice: 100, listedPrice: 100, outcome: 'success', latencyMs: 5, errorCode: null, occurredAt: new Date().toISOString() }] as never);
  enqueueTrades([{ tradeId: 't-1', resourceId: 1, buyPrice: 100 }] as never);
  enqueueFilterStats([{ filterId: 'f-1', windowStart: new Date().toISOString(), searches: 1, attempts: 1, successes: 1, coinsSpent: 100, coinsEarned: 150 }] as never);
  enqueueRiskEvents([{ kind: 'actions_per_hour', value: 1, threshold: 30, deviceId: 'd-1', sessionId: 's-1', occurredAt: new Date().toISOString() }] as never);
  enqueueTelemetry([{ type: 'version_ping', occurredAt: new Date().toISOString() }] as never);
}

describe('lib/telemetry.ts: flush() re-queues only the batch that actually failed', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await applyServerSettings({ ...DEFAULT_SETTINGS, version: 1, telemetryOptOut: false });
    fillQueueWithOneOfEach();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('when only the sniping batch POST fails, the other five are reported sent and are not re-queued', async () => {
    // A 400 (not 429/5xx) fails on the first attempt with no retry/backoff
    // delay — see lib/http.ts's `retryFetch` — so this stays fast while
    // still exercising a real per-batch rejection.
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/sniping/attempts')) {
        return jsonResponse(400, { error: { code: 'BAD_REQUEST', message: 'nope' } });
      }
      return jsonResponse(200, { accepted: 1 });
    });

    const result = await flush();

    expect(result.ok).toBe(false);
    expect(result.sent).toBe(5); // every batch except sniping actually went out
    expect(pendingCount()).toBe(1); // only the failed sniping batch is back on the queue

    // A second flush, now with the network healthy, must send only the
    // re-queued sniping batch — the five that already succeeded must not be
    // sent (and therefore not duplicated) a second time.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => jsonResponse(200, { accepted: 1 }));

    const retry = await flush();

    expect(retry).toEqual({ ok: true, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/sniping/attempts');
    expect(pendingCount()).toBe(0);
  });

  it('when every batch POST fails, all six are re-queued and none are reported sent', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(400, { error: { code: 'BAD_REQUEST', message: 'nope' } }));

    const result = await flush();

    expect(result).toEqual({ ok: false, sent: 0 });
    expect(pendingCount()).toBe(6); // one of each of the six queued categories, all put back
  });
});
