// Ingest correctness (P0 task 11), extension side: a flush must never
// duplicate data the API already has, never retry a batch the API will
// always reject, and never queue data it is not allowed to send.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type * as SettingsModule from '../../src/lib/settings.js';
import type * as StorageModule from '../../src/lib/storage.js';
import type * as TelemetryModule from '../../src/lib/telemetry.js';

const DAY = 24 * 60 * 60 * 1000;

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

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    telemetry = await import('../../src/lib/telemetry.js');
    settings = await import('../../src/lib/settings.js');
    storage = await import('../../src/lib/storage.js');
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
});
