// Ingest correctness (P0 task 11), extension side: a flush must never
// duplicate data the API already has, never retry a batch the API will
// always reject, and never queue data it is not allowed to send.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type * as ClockModule from '../../src/lib/clock.js';
import type * as SettingsModule from '../../src/lib/settings.js';
import type * as StorageModule from '../../src/lib/storage.js';
import type * as TelemetryModule from '../../src/lib/telemetry.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function snipe(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: 7,
    targetPrice: 500,
    listedPrice: 480,
    outcome: 'success',
    latencyMs: 12,
    errorCode: null,
    occurredAt: new Date().toISOString(),
    deviceId: '00000000-0000-0000-0000-000000000000',
    ...overrides,
  };
}

function activity() {
  return { type: 'search', occurredAt: new Date().toISOString(), metadata: {} };
}

function pathOf(call: unknown[]): string {
  return String(call[0]);
}

function bodyOf(call: unknown[]): Record<string, unknown[]> {
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown[]>;
}

describe('lib/telemetry.ts: flush and enqueue correctness', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;
  let telemetry: typeof TelemetryModule;
  let settings: typeof SettingsModule;
  let storage: typeof StorageModule;
  let clock: typeof ClockModule;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    telemetry = await import('../../src/lib/telemetry.js');
    settings = await import('../../src/lib/settings.js');
    storage = await import('../../src/lib/storage.js');
    clock = await import('../../src/lib/clock.js');
    await settings.applyServerSettings({ ...settings.DEFAULT_SETTINGS, version: 1, telemetryOptOut: false });
    await telemetry.whenHydrated();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives every queued sniping attempt an attemptId, kept with it in the persisted queue', async () => {
    telemetry.enqueueSniping([snipe()] as never);
    await telemetry.whenPersisted();
    const persisted = await storage.getSession<{ sniping: { attemptId?: string }[] }>('sl.telemetry.queue.v1', {
      sniping: [],
    });
    expect(persisted.sniping[0]?.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a partial flush failure re-sends only the batch that failed, with the same attemptId and occurredAt', async () => {
    telemetry.enqueueActivity([activity()] as never);
    telemetry.enqueueSniping([snipe()] as never);

    // Activity succeeds; sniping keeps failing with a 503 (retryable).
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/sniping/') ? json(503, { code: 'UNAVAILABLE' }) : json(200, { accepted: 1 }),
    );
    const first = await telemetry.flush();
    expect(first.ok).toBe(false);
    expect(telemetry.pendingCount()).toBe(1);
    const failedBody = bodyOf(fetchMock.mock.calls.find((c) => pathOf(c).includes('/sniping/'))!);

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => json(200, { accepted: 1 }));
    const second = await telemetry.flush();

    expect(second).toEqual({ ok: true, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pathOf(fetchMock.mock.calls[0]!)).toContain('/sniping/attempts');
    // Same identity on the retry, so the API's unique index dedupes it.
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual(failedBody);
  }, 20_000);

  it('drops a batch the API rejects with a 4xx instead of re-queueing it forever', async () => {
    telemetry.enqueueSniping([snipe()] as never);
    fetchMock.mockImplementation(async () => json(400, { code: 'VALIDATION_FAILED' }));

    const result = await telemetry.flush();
    expect(result.sent).toBe(0);
    expect(telemetry.pendingCount()).toBe(0);

    fetchMock.mockClear();
    await telemetry.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a batch rejected with 429 (rate limited) for the next tick', async () => {
    telemetry.enqueueSniping([snipe()] as never);
    // retryFetch retries 429 itself first; keep answering 429.
    fetchMock.mockImplementation(async () => json(429, { code: 'RATE_LIMITED' }));

    const result = await telemetry.flush();
    expect(result.ok).toBe(false);
    expect(telemetry.pendingCount()).toBe(1);
  }, 20_000);

  it('does not send items older than the API accepts, so one stale item cannot sink a batch', async () => {
    telemetry.enqueueSniping([
      snipe({ occurredAt: new Date(Date.now() - 8 * DAY).toISOString() }),
      snipe(),
    ] as never);
    fetchMock.mockImplementation(async () => json(200, { accepted: 1 }));

    const result = await telemetry.flush();
    expect(result).toEqual({ ok: true, sent: 1 });
    expect(bodyOf(fetchMock.mock.calls[0]!).attempts).toHaveLength(1);
  });

  it('caps the queue, dropping the oldest items first', async () => {
    const many = Array.from({ length: telemetry.MAX_QUEUED_PER_KIND + 5 }, (_, i) =>
      snipe({ resourceId: i + 1 }),
    );
    telemetry.enqueueSniping(many as never);
    expect(telemetry.pendingCount()).toBe(telemetry.MAX_QUEUED_PER_KIND);

    fetchMock.mockImplementation(async () => json(200, { accepted: 1 }));
    await telemetry.flush();
    const sent = fetchMock.mock.calls.flatMap((c) => bodyOf(c).attempts as { resourceId: number }[]);
    expect(sent[0]?.resourceId).toBe(6); // the five oldest went
  });

  describe('enqueue() gate', () => {
    it('queues nothing without an account', async () => {
      const res = await telemetry.enqueue({ kind: 'sniping', items: [snipe()] as never });
      expect(res).toEqual({ queued: 0 });
      expect(telemetry.pendingCount()).toBe(0);
    });

    it('queues nothing when opted out, even with an account', async () => {
      await storage.setSession('sl.accessToken', 'token');
      await settings.applyServerSettings({ ...settings.DEFAULT_SETTINGS, version: 1, telemetryOptOut: true });
      const res = await telemetry.enqueue({ kind: 'activity', items: [activity()] as never });
      expect(res).toEqual({ queued: 0 });
      expect(telemetry.pendingCount()).toBe(0);
    });

    it('queues with an account, including after a browser restart cleared the access token', async () => {
      await storage.setLocal('sl.refreshTokenEnc', 'encrypted-refresh-token');
      const res = await telemetry.enqueue({ kind: 'sniping', items: [snipe()] as never });
      expect(res).toEqual({ queued: 1 });
      expect(telemetry.pendingCount()).toBe(1);
    });
  });

  // Review fix round 1: the API keeps its window strict (clamping would
  // break the sniping idempotency key), so the extension corrects its own
  // clock from the server's `serverTime`, once, when an item is queued.
  describe('clock skew and out-of-window items', () => {
    /** An API whose clock is `skewMs` behind this machine's, rejecting what
     * its real ingest window would (5 minutes ahead). */
    function serverBehindBy(skewMs: number) {
      return async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { attempts?: { occurredAt: string }[] };
        const serverNow = Date.now() - skewMs;
        const indices = (body.attempts ?? [])
          .map((a, i) => (Date.parse(a.occurredAt) > serverNow + 5 * MINUTE ? i : -1))
          .filter((i) => i >= 0);
        if (indices.length > 0) return json(400, { code: 'TIMESTAMP_OUT_OF_WINDOW', message: 'x', details: { indices } });
        return json(200, { accepted: body.attempts?.length ?? 0 });
      };
    }

    it('a client 10 minutes fast loses nothing, even after a service-worker restart', async () => {
      const now = Date.now();
      // Heartbeat: the server says it is 10 minutes earlier than we think.
      await clock.recordServerTime(new Date(now - 10 * MINUTE).toISOString(), now, now);

      // Fresh service worker: the offset comes back from storage.
      vi.resetModules();
      telemetry = await import('../../src/lib/telemetry.js');
      await telemetry.whenHydrated();
      await storage.setLocal('sl.refreshTokenEnc', 'encrypted-refresh-token');

      const res = await telemetry.enqueue({ kind: 'sniping', items: [snipe(), snipe()] as never });
      expect(res).toEqual({ queued: 2 });

      fetchMock.mockImplementation(serverBehindBy(10 * MINUTE));
      const result = await telemetry.flush();
      expect(result).toEqual({ ok: true, sent: 2 });
      expect(telemetry.pendingCount()).toBe(0);
    });

    it('a restarted worker whose first act is a flush judges queued items on the server clock', async () => {
      // This machine runs 10 minutes slow: queued items were moved forward
      // to server time, i.e. 10 minutes ahead of the local clock.
      const now = Date.now();
      await clock.recordServerTime(new Date(now + 10 * MINUTE).toISOString(), now, now);
      telemetry.enqueueSniping([snipe(), snipe()] as never);
      await telemetry.whenPersisted();

      // The flush alarm wakes a fresh service worker: nothing has loaded the
      // offset yet when flush() runs.
      vi.resetModules();
      telemetry = await import('../../src/lib/telemetry.js');

      fetchMock.mockImplementation(serverBehindBy(-10 * MINUTE));
      const result = await telemetry.flush();
      expect(result).toEqual({ ok: true, sent: 2 });
      expect(telemetry.pendingCount()).toBe(0);
    });

    it('drops only the out-of-window item of a chunk and still sends the rest', async () => {
      telemetry.enqueueSniping([snipe({ resourceId: 1 }), snipe({ resourceId: 2 }), snipe({ resourceId: 3 })] as never);
      fetchMock
        .mockImplementationOnce(async () =>
          json(400, { code: 'TIMESTAMP_OUT_OF_WINDOW', message: 'x', details: { indices: [1] } }),
        )
        .mockImplementation(async () => json(200, { accepted: 2 }));

      const result = await telemetry.flush();
      expect(result).toEqual({ ok: true, sent: 2 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const resent = bodyOf(fetchMock.mock.calls[1]!).attempts as { resourceId: number }[];
      expect(resent.map((a) => a.resourceId)).toEqual([1, 3]);
      expect(telemetry.pendingCount()).toBe(0);
    });

    it('a retry resends byte-identical timestamps, even after the offset changes', async () => {
      const now = Date.now();
      await clock.recordServerTime(new Date(now - 10 * MINUTE).toISOString(), now, now);
      telemetry.enqueueSniping([snipe()] as never);
      telemetry.enqueueTrades([
        { tradeId: 't', resourceId: 1, assetId: null, rating: null, buyPrice: 100, sellPrice: null, eaTax: 0, netProfit: null, status: 'bought', boughtAt: new Date().toISOString(), soldAt: null },
      ] as never);

      fetchMock.mockImplementation(async () => json(503, { code: 'INTERNAL' }));
      await telemetry.flush();
      const first = fetchMock.mock.calls.map((c) => [pathOf(c), bodyOf(c)] as const);
      // Queued with the corrected clock.
      const sentAt = Date.parse((first.find(([p]) => p.includes('/sniping/'))![1].attempts?.[0] as { occurredAt: string }).occurredAt);
      expect(Math.abs(sentAt - (now - 10 * MINUTE))).toBeLessThan(MINUTE);

      // The next heartbeat measures a different offset; queued items keep theirs.
      await clock.recordServerTime(new Date(Date.now() - 3 * MINUTE).toISOString(), Date.now(), Date.now());
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => json(200, { accepted: 1 }));
      await telemetry.flush();
      const second = fetchMock.mock.calls.map((c) => [pathOf(c), bodyOf(c)] as const);
      // retryFetch retried the 503s, so compare the distinct requests.
      const distinct = (calls: (readonly [string, unknown])[]) =>
        [...new Map(calls.map(([p, b]) => [p, JSON.stringify(b)])).entries()].sort();
      expect(distinct(second)).toEqual(distinct(first));
    }, 30_000);

    it('keeps trade reports up to 400 days old; activity and sniping only 7 days', async () => {
      telemetry.enqueueTrades([
        { tradeId: 'old', resourceId: 1, assetId: null, rating: null, buyPrice: 100, sellPrice: null, eaTax: 0, netProfit: null, status: 'listed', boughtAt: new Date(Date.now() - 30 * DAY).toISOString(), soldAt: null },
      ] as never);
      telemetry.enqueueSniping([snipe({ occurredAt: new Date(Date.now() - 8 * DAY).toISOString() })] as never);
      fetchMock.mockImplementation(async () => json(200, { accepted: 1 }));

      const result = await telemetry.flush();
      expect(result).toEqual({ ok: true, sent: 1 });
      expect(pathOf(fetchMock.mock.calls[0]!)).toContain('/trades/batch');
    });
  });
});
