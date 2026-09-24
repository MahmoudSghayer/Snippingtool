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

  it('hands trade-pile items to onTradePile, and drops malformed ones', async () => {
    const cb = vi.fn();
    client.onTradePile(cb);
    const item = { itemId: '11', tradeId: '7011', resourceId: 42, rating: 88, tradeState: 'closed', currentBid: 13_500, buyNowPrice: 14_000, expires: 0 };
    deliver({ channel: ADAPTER_CHANNEL, kind: 'tradepile', data: { url: '/ut/game/fc25/tradepile', seenAt: 1, items: [{ ...item, tradeState: 'sold' }] } });
    await flush();
    expect(cb).not.toHaveBeenCalled();
    deliver({ channel: ADAPTER_CHANNEL, kind: 'tradepile', data: { url: '/ut/game/fc25/tradepile', seenAt: 1, items: [item] } });
    await flush();
    expect(cb).toHaveBeenCalledWith([item]);
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

describe('a buy whose answer came after the adapter stopped waiting', () => {
  it('resolves timeout_unknown with a late promise that a signed late result settles', async () => {
    const promise = client.buy('t1', 1000);
    const req = await lastRequest();
    const requestId = req.data.requestId as string;
    deliver(await signedResult({ action: 'buy', requestId, ok: false, error: 'timeout_unknown', requestedAt: 1, completedAt: 12_001 }));
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, error: 'timeout_unknown' });
    expect(outcome.late).toBeInstanceOf(Promise);

    // An unsigned late result is ignored...
    deliver({ channel: ADAPTER_CHANNEL, kind: 'action_result', data: { action: 'buy', requestId, ok: true, late: true, requestedAt: 1, completedAt: 20_000 } });
    // ...a signed one settles it.
    deliver(await signedResult({ action: 'buy', requestId, ok: true, late: true, requestedAt: 1, completedAt: 20_001 }));
    await expect(outcome.late).resolves.toMatchObject({ ok: true, latencyMs: 20_000 });
  });

  it('ignores a late result for a request that did not time out', async () => {
    const promise = client.buy('t1', 1000);
    const req = await lastRequest();
    deliver(await signedResult({ action: 'buy', requestId: req.data.requestId, ok: false, error: 'price_mismatch', requestedAt: 1, completedAt: 2 }));
    const outcome = await promise;
    expect(outcome.late).toBeUndefined();
  });
});

describe('only a signed result is marked signed', () => {
  it('marks a verified result signed, and a timeout after a forged unready probe not', async () => {
    const promise = client.buy('t1', 1000);
    const req = await lastRequest();
    deliver(await signedResult({ action: 'buy', requestId: req.data.requestId, ok: false, error: 'price_mismatch', requestedAt: 1, completedAt: 2 }));
    await expect(promise).resolves.toMatchObject({ error: 'price_mismatch', signed: true });

    client.dispose();
    client = createAdapterClient(window, NONCE, { timeoutMs: 50 });
    deliver({ channel: ADAPTER_CHANNEL, kind: 'probe', data: { ok: true, checkedAt: 1, actReady: false } });
    await flush();
    const forged = await client.buy('t1', 1000);
    expect(forged).toMatchObject({ ok: false, error: 'adapter_unauthenticated' });
    expect(forged.signed).toBeUndefined();
  });
});

describe('a late result that overtakes its timeout_unknown', () => {
  it('is held briefly and picked up when the primary result arrives', async () => {
    const promise = client.buy('t1', 1000);
    const req = await lastRequest();
    const requestId = req.data.requestId as string;
    deliver(await signedResult({ action: 'buy', requestId, ok: true, late: true, requestedAt: 1, completedAt: 30 }));
    await flush();
    deliver(await signedResult({ action: 'buy', requestId, ok: false, error: 'timeout_unknown', requestedAt: 1, completedAt: 20 }));
    const outcome = await promise;
    await expect(outcome.late).resolves.toMatchObject({ ok: true, signed: true });
  });

  it('is not held for a request this client never made', async () => {
    deliver(await signedResult({ action: 'buy', requestId: 'not-mine', ok: true, late: true, requestedAt: 1, completedAt: 30 }));
    await flush();
    // Nothing to assert on directly beyond "no throw"; a later unrelated buy is unaffected.
    const promise = client.buy('t2', 1000);
    const req = await lastRequest();
    deliver(await signedResult({ action: 'buy', requestId: req.data.requestId, ok: true, requestedAt: 1, completedAt: 2 }));
    await expect(promise).resolves.toMatchObject({ ok: true });
  });
});

describe('the Sniping Bot catalog (same authenticated channel as act calls)', () => {
  const CATALOG = {
    players: [{ id: 158023, name: 'Messi', rating: 88 }],
    levels: [{ id: 2, value: 'gold', label: 'Gold' }],
    rarities: [],
    positions: [],
    playStyles: [],
    nations: [],
    leagues: [],
    clubs: {},
    capturedAt: 1,
  };

  async function signedCatalog(data: Record<string, unknown>) {
    return { channel: ADAPTER_CHANNEL, kind: 'catalog', data, mac: await signer.sign(canonicalActMessage('catalog', data)) };
  }

  it('asks for it with a signed act request, never with the nonce itself', async () => {
    client.requestCatalog();
    const request = await lastRequest();
    expect(request).toMatchObject({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: { action: 'catalog' } });
    expect(await signer.verify(canonicalActMessage('act_request', request.data), request.mac)).toBe(true);
    expect(JSON.stringify(request)).not.toContain(NONCE);
  });

  it('sends nothing without a nonce', async () => {
    const keyless = createAdapterClient(window, null);
    keyless.requestCatalog();
    await flush();
    expect(sent).toHaveLength(0);
    keyless.dispose();
  });

  it('delivers a catalog only when its MAC verifies', async () => {
    const cb = vi.fn();
    client.onCatalog(cb);
    deliver({ channel: ADAPTER_CHANNEL, kind: 'catalog', data: { catalog: CATALOG } });
    deliver({ channel: ADAPTER_CHANNEL, kind: 'catalog', data: { catalog: CATALOG }, mac: 'f'.repeat(64) });
    const forger = createActSigner(generateNonce())!;
    const forgedData = { catalog: CATALOG };
    deliver({ channel: ADAPTER_CHANNEL, kind: 'catalog', data: forgedData, mac: await forger.sign(canonicalActMessage('catalog', forgedData)) });
    // An action_result's MAC does not pass for a catalog.
    deliver({ channel: ADAPTER_CHANNEL, kind: 'catalog', data: forgedData, mac: await signer.sign(canonicalActMessage('action_result', forgedData)) });
    await flush();
    expect(cb).not.toHaveBeenCalled();

    deliver(await signedCatalog({ catalog: CATALOG }));
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(CATALOG));
  });

  it('drops a signed catalog that does not match the schema', async () => {
    const cb = vi.fn();
    client.onCatalog(cb);
    deliver(await signedCatalog({ catalog: { ...CATALOG, players: [{ id: -1, name: '', rating: 200 }] } }));
    deliver(await signedCatalog({ catalog: { ...CATALOG, injected: '<img onerror=alert(1)>' } }));
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });
});
