// Unit coverage for content/adapter-client.ts (defects C10, C12): every
// page -> content message is schema-validated before anything acts on it,
// an `action_result` only ever resolves the request content itself issued
// (matching requestId and action, once, carrying the adapter's MAC), and
// outgoing act requests are authenticated without ever putting the nonce
// itself on the page-visible channel.

import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAdapterClient, type AdapterClient } from '../../src/content/adapter-client.js';
import { canonicalActMessage, createActSigner, generateNonce, type ActSigner } from '../../src/lib/act-auth.js';

const NONCE = generateNonce();
let signer: ActSigner;
let client: AdapterClient;
let sent: { channel: string; kind: string; data: Record<string, unknown>; mac?: string }[];

function deliver(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message, source: window }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function lastRequest() {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
  return sent[sent.length - 1]!;
}

async function signedResult(data: Record<string, unknown>) {
  return { channel: ADAPTER_CHANNEL, kind: 'action_result', data, mac: await signer.sign(canonicalActMessage('action_result', data)) };
}

const AUCTION = { tradeId: 't1', resourceId: 1, assetId: 1, rating: 80, buyNow: 1000, startingBid: 150, currentBid: 0, offers: 0, expiresAt: null, seenAt: 1 };

beforeEach(() => {
  signer = createActSigner(NONCE)!;
  sent = [];
  vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown) => {
    sent.push(message as (typeof sent)[number]);
  }) as typeof window.postMessage);
  client = createAdapterClient(window, NONCE);
});

afterEach(() => {
  client.dispose();
  vi.restoreAllMocks();
});

describe('page -> content message validation', () => {
  it('drops auctions messages that do not match the schema', async () => {
    const cb = vi.fn();
    client.onAuctions(cb);
    deliver({ channel: ADAPTER_CHANNEL, kind: 'auctions', data: { auctions: [{ tradeId: 't1', buyNow: 'cheap' }] } });
    deliver({ channel: ADAPTER_CHANNEL, kind: 'auctions', data: null });
    await flush();
    expect(cb).not.toHaveBeenCalled();

    deliver({ channel: ADAPTER_CHANNEL, kind: 'auctions', data: { url: 'u', seenAt: 1, auctions: [AUCTION], stats: { seen: 1, parsed: 1, failed: 0 } } });
    await flush();
    expect(cb).toHaveBeenCalledWith([AUCTION]);
  });

  it('drops malformed probe and shape messages', async () => {
    const onProbe = vi.fn();
    const onShape = vi.fn();
    client.onProbe(onProbe);
    client.onShape(onShape);
    deliver({ channel: ADAPTER_CHANNEL, kind: 'probe', data: { ok: 'yes' } });
    deliver({ channel: ADAPTER_CHANNEL, kind: 'shape', data: {} });
    await flush();
    expect(onProbe).not.toHaveBeenCalled();
    expect(onShape).not.toHaveBeenCalled();
    expect(client.probeStatus).toBeNull();
  });

  it('ignores messages from another source', async () => {
    const cb = vi.fn();
    client.onProbe(cb);
    window.dispatchEvent(new MessageEvent('message', { data: { channel: ADAPTER_CHANNEL, kind: 'probe', data: { ok: true, checkedAt: 1 } } }));
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('act requests', () => {
  it('carry a MAC that verifies under the nonce, and never the nonce itself', async () => {
    void client.buy('t1', 1000);
    const req = await lastRequest();
    expect(req.kind).toBe('act_request');
    expect(req.data).toMatchObject({ action: 'buy', tradeId: 't1', price: 1000 });
    expect(await signer.verify(canonicalActMessage('act_request', req.data), req.mac!)).toBe(true);
    expect(JSON.stringify(req)).not.toContain(NONCE);
  });

  it('refuse a zero or negative price without posting (no buy-now price to match)', async () => {
    await expect(client.buy('t1', 0)).resolves.toMatchObject({ ok: false, error: 'price_mismatch' });
    expect(sent).toHaveLength(0);
  });

  it('an unsigned actReady:false probe (forgeable by any page script) does not fail a pending buy', async () => {
    const promise = client.buy('t1', 1000);
    const req = await lastRequest();
    let settled: unknown = null;
    void promise.then((o) => (settled = o));
    for (let i = 0; i < 3; i++) deliver({ channel: ADAPTER_CHANNEL, kind: 'probe', data: { ok: true, checkedAt: 1, actReady: false } });
    await flush();
    expect(settled).toBeNull();

    deliver(await signedResult({ action: 'buy', requestId: req.data.requestId, ok: true, requestedAt: 1, completedAt: 4 }));
    await expect(promise).resolves.toMatchObject({ ok: true, latencyMs: 3 });
  });

  it('a timeout after an actReady:false probe is reported as adapter_unauthenticated (non-retryable)', async () => {
    client.dispose();
    client = createAdapterClient(window, NONCE, { timeoutMs: 50 });
    const plain = await client.buy('t1', 1000);
    expect(plain).toMatchObject({ ok: false, error: 'timed out waiting for adapter response' });

    deliver({ channel: ADAPTER_CHANNEL, kind: 'probe', data: { ok: true, checkedAt: 1, actReady: false } });
    await flush();
    await expect(client.buy('t1', 1000)).resolves.toMatchObject({ ok: false, error: 'adapter_unauthenticated' });
  });

  it('a verified action_result clears the unready flag, so later timeouts are ordinary again', async () => {
    client.dispose();
    client = createAdapterClient(window, NONCE, { timeoutMs: 200 });
    deliver({ channel: ADAPTER_CHANNEL, kind: 'probe', data: { ok: true, checkedAt: 1, actReady: false } });
    await flush();
    const first = client.buy('t1', 1000);
    const req = await lastRequest();
    deliver(await signedResult({ action: 'buy', requestId: req.data.requestId, ok: true, requestedAt: 1, completedAt: 2 }));
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(client.buy('t1', 1000)).resolves.toMatchObject({ ok: false, error: 'timed out waiting for adapter response' });
  });

  it('fail closed without a nonce, posting nothing', async () => {
    client.dispose();
    client = createAdapterClient(window, null);
    const outcome = await client.buy('t1', 1000);
    expect(outcome).toMatchObject({ ok: false, error: 'adapter_unauthenticated' });
    expect(sent).toHaveLength(0);
  });
});

describe('action_result correlation', () => {
  it('resolves only on a signed result for the pending requestId and action, once', async () => {
    const promise = client.buy('t1', 1000);
    const req = await lastRequest();
    const requestId = req.data.requestId as string;
    let settled: unknown = null;
    void promise.then((o) => (settled = o));

    // Unknown requestId.
    deliver(await signedResult({ action: 'buy', requestId: 'someone-else', ok: true, requestedAt: 1, completedAt: 2 }));
    // Right requestId, but a forged `ok: true` with no MAC / a bad MAC.
    deliver({ channel: ADAPTER_CHANNEL, kind: 'action_result', data: { action: 'buy', requestId, ok: true, requestedAt: 1, completedAt: 2 } });
    deliver({ channel: ADAPTER_CHANNEL, kind: 'action_result', data: { action: 'buy', requestId, ok: true, requestedAt: 1, completedAt: 2 }, mac: 'a'.repeat(64) });
    // Right requestId, wrong action.
    deliver(await signedResult({ action: 'search', requestId, ok: true, requestedAt: 1, completedAt: 2 }));
    await flush();
    expect(settled).toBeNull();

    // The genuine result resolves it...
    deliver(await signedResult({ action: 'buy', requestId, ok: false, error: 'price_mismatch', requestedAt: 1, completedAt: 3 }));
    await expect(promise).resolves.toMatchObject({ ok: false, error: 'price_mismatch', latencyMs: 2 });

    // ...and a duplicate of a completed request is dropped (nothing throws,
    // nothing else resolves).
    deliver(await signedResult({ action: 'buy', requestId, ok: true, requestedAt: 1, completedAt: 2 }));
    await flush();
    expect(settled).toMatchObject({ ok: false, error: 'price_mismatch' });
  });
});

describe('diagnostics', () => {
  const REPORT = {
    probe: { ok: false, reason: 'no known service-layer shape', shape: null, checkedAt: 1 },
    candidates: [{ shape: 'promise', present: false, reason: 'missing' }],
    servicesKeys: 'undefined',
    globals: { UTSearchCriteriaDTO: 'undefined' },
    lastMarketResponse: null,
    stats: { seen: 0, parsed: 0, failed: 0 },
    log: ['probe failed'],
  };

  it('asks over the authenticated channel and resolves with the signed report', async () => {
    const promise = client.diagnostics();
    const req = await lastRequest();
    expect(req.data).toMatchObject({ action: 'diagnostics' });
    expect(await signer.verify(canonicalActMessage('act_request', req.data), req.mac!)).toBe(true);
    deliver(await signedResult({ action: 'diagnostics', requestId: req.data.requestId, ok: true, requestedAt: 1, completedAt: 2, diagnostics: REPORT }));
    await expect(promise).resolves.toMatchObject({ ok: true, diagnostics: REPORT });
  });

  it('ignores an unsigned report', async () => {
    client.dispose();
    client = createAdapterClient(window, NONCE, { timeoutMs: 100 });
    const promise = client.diagnostics();
    const req = await lastRequest();
    deliver({
      channel: ADAPTER_CHANNEL,
      kind: 'action_result',
      data: { action: 'diagnostics', requestId: req.data.requestId, ok: true, requestedAt: 1, completedAt: 2, diagnostics: REPORT },
    });
    await expect(promise).resolves.toMatchObject({ ok: false, error: 'timed out waiting for adapter response' });
  });
});
