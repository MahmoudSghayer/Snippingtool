// Unit coverage for main/adapter.ts's act surface (defects C10, C12):
//   - no act request runs without a valid MAC under the per-page-load nonce
//     (so a page script cannot drive buyNow around the governor);
//   - a buy only goes through when the price content expects equals the
//     buy-now price the adapter itself last saw for that tradeId;
//   - listings the adapter records come only from real EA market responses.
//
// adapter.ts wires itself up at import time (it is a MAIN-world content
// script, not a library), so this file imports it exactly once, after
// setting up the page it expects to find.

import { adapterCatalogMessageSchema } from '@sl/shared';
import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_ATTRIBUTE, canonicalActMessage, createActSigner, generateNonce, type ActSigner } from '../../src/lib/act-auth.js';

const NONCE = generateNonce();
let signer: ActSigner;

const buyNow = vi.fn(async (_tradeId: string) => ({ success: true }));
const search = vi.fn(async (_criteria: Record<string, unknown>): Promise<unknown> => ({ auctionInfo: [] }));
const nativeFetch = vi.fn(async (_input: unknown) => new Response('{}'));

/** A Response as the network would hand it back: with its final URL set.
 * `new Response()` always has `url === ''`, so beforeAll swaps the url
 * getter adapter.ts captures for one that reads this test-only field. */
function networkResponse(body: unknown, url: string): Response {
  const res = new Response(JSON.stringify(body));
  (res as unknown as { __testUrl: string }).__testUrl = url;
  return res;
}

function rawAuction(tradeId: number, buyNowPrice: number) {
  return { tradeId, buyNowPrice, startingBid: 150, currentBid: 0, offers: 0, expires: 3600, itemData: { resourceId: 42, assetId: 42, rating: 85 } };
}

interface Posted {
  channel: string;
  kind: string;
  data: Record<string, unknown>;
  mac?: string;
}
let posted: Posted[] = [];

function results(): Posted[] {
  return posted.filter((m) => m.kind === 'action_result');
}

function deliver(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message, source: window }));
}

async function signedRequest(data: Record<string, unknown>): Promise<Posted> {
  const mac = await signer.sign(canonicalActMessage('act_request', data));
  return { channel: ADAPTER_CHANNEL, kind: 'act_request', data, mac };
}

async function resultFor(requestId: string): Promise<Posted> {
  await vi.waitFor(() => expect(results().find((r) => r.data.requestId === requestId)).toBeDefined());
  return results().find((r) => r.data.requestId === requestId)!;
}

/** Nothing arrives for a request the adapter ignored, so wait long enough
 * for one that *would* have been answered (MAC check + probe + a resolved
 * promise) before asserting on silence. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeAll(async () => {
  signer = createActSigner(NONCE)!;
  (window as unknown as { services: unknown }).services = {
    Item: { repository: { search } },
    Transfer: { repository: { buyNow, bid: vi.fn() } },
  };
  // adapter.ts captures `fetch` at import; this stub stands in for the
  // network so the passive-observation tests below never leave the process.
  window.fetch = nativeFetch as unknown as typeof window.fetch;
  Object.defineProperty(Response.prototype, 'url', {
    configurable: true,
    get(this: { __testUrl?: string }) {
      return this.__testUrl ?? '';
    },
  });
  // Likewise for XHR: the adapter forwards to whatever `send` it captured.
  XMLHttpRequest.prototype.send = function () {};
  window.addEventListener('message', (e) => {
    const m = e.data as Posted | null;
    if (m && m.channel === ADAPTER_CHANNEL) posted.push(m);
  });
  document.documentElement.setAttribute(HANDOFF_ATTRIBUTE, NONCE);
  await import('../../src/main/adapter.js');
});

beforeEach(() => {
  posted = [];
  buyNow.mockClear();
  search.mockClear();
});

describe('adapter handoff', () => {
  it('removes the nonce from the DOM as soon as it has read it', () => {
    expect(document.documentElement.hasAttribute(HANDOFF_ATTRIBUTE)).toBe(false);
  });
});

describe('act channel nonce gate', () => {
  it('ignores a buy request with no MAC', async () => {
    deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: { action: 'buy', requestId: 'no-mac', tradeId: '1', price: 1 } });
    await settle();
    expect(buyNow).not.toHaveBeenCalled();
    expect(results()).toHaveLength(0);
  });

  it('ignores a request signed with any other key', async () => {
    const forger = createActSigner(generateNonce())!;
    const data = { action: 'search', requestId: 'forged', filter: {} };
    deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data, mac: await forger.sign(canonicalActMessage('act_request', data)) });
    await settle();
    expect(search).not.toHaveBeenCalled();
    expect(results()).toHaveLength(0);
  });

  it('ignores a validly signed request whose fields were changed afterwards', async () => {
    const req = await signedRequest({ action: 'search', requestId: 'tampered', filter: {} });
    deliver({ ...req, data: { ...req.data, filter: { minPrice: 5 } } });
    await settle();
    expect(search).not.toHaveBeenCalled();
  });

  it('runs a correctly signed request, signs its result, and ignores a replay of it', async () => {
    const req = await signedRequest({ action: 'search', requestId: 'good-search', filter: {} });
    deliver(req);
    const result = await resultFor('good-search');
    expect(result.data.ok).toBe(true);
    expect(await signer.verify(canonicalActMessage('action_result', result.data), result.mac!)).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);

    deliver(req);
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('buy price re-check', () => {
  async function seeListing(tradeId: number, price: number): Promise<void> {
    search.mockResolvedValueOnce({ auctionInfo: [rawAuction(tradeId, price)] });
    const requestId = `see-${tradeId}-${price}`;
    deliver(await signedRequest({ action: 'search', requestId, filter: {} }));
    await resultFor(requestId);
  }

  it('refuses a tradeId the adapter has never seen listed', async () => {
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-unknown', tradeId: '999999', price: 100 }));
    const result = await resultFor('buy-unknown');
    expect(result.data).toMatchObject({ ok: false, error: 'listing_unknown' });
    expect(buyNow).not.toHaveBeenCalled();
  });

  it('refuses when the expected price differs from the listed buy-now price', async () => {
    await seeListing(5001, 90_000);
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-cheap', tradeId: '5001', price: 900 }));
    const result = await resultFor('buy-cheap');
    expect(result.data).toMatchObject({ ok: false, error: 'price_mismatch' });
    expect(buyNow).not.toHaveBeenCalled();
  });

  it('buys when the expected price matches the listing', async () => {
    await seeListing(5002, 12_000);
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-match', tradeId: '5002', price: 12_000 }));
    const result = await resultFor('buy-match');
    expect(result.data).toMatchObject({ ok: true });
    expect(buyNow).toHaveBeenCalledWith('5002');
  });

  it('never buys a listing with no buy-now price, and drops a zero-price buy request', async () => {
    await seeListing(5004, 0);
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-zero', tradeId: '5004', price: 0 }));
    await settle();
    expect(results().find((r) => r.data.requestId === 'buy-zero')).toBeUndefined();
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-nobin', tradeId: '5004', price: 100 }));
    expect((await resultFor('buy-nobin')).data).toMatchObject({ ok: false, error: 'price_mismatch' });
    expect(buyNow).not.toHaveBeenCalled();
  });

  it('refuses a buy for a different card than the listing the adapter saw (resourceId / assetId bound)', async () => {
    await seeListing(5005, 11_000); // resourceId 42, assetId 42 (rawAuction)
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-wrong-card', tradeId: '5005', price: 11_000, resourceId: 77 }));
    expect((await resultFor('buy-wrong-card')).data).toMatchObject({ ok: false, error: 'resource_mismatch' });
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-wrong-asset', tradeId: '5005', price: 11_000, resourceId: 42, assetId: 77 }));
    expect((await resultFor('buy-wrong-asset')).data).toMatchObject({ ok: false, error: 'resource_mismatch' });
    expect(buyNow).not.toHaveBeenCalled();

    deliver(await signedRequest({ action: 'buy', requestId: 'buy-right-card', tradeId: '5005', price: 11_000, resourceId: 42, assetId: 42 }));
    expect((await resultFor('buy-right-card')).data).toMatchObject({ ok: true });
    expect(buyNow).toHaveBeenCalledWith('5005');
  });

  it('drops a buy request whose resourceId is not a positive integer', async () => {
    await seeListing(5006, 11_000);
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-bad-id', tradeId: '5006', price: 11_000, resourceId: -1 }));
    await settle();
    expect(results().find((r) => r.data.requestId === 'buy-bad-id')).toBeUndefined();
    expect(buyNow).not.toHaveBeenCalled();
  });

  it('uses the latest price seen for a tradeId', async () => {
    await seeListing(5003, 12_000);
    await seeListing(5003, 15_000);
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-stale', tradeId: '5003', price: 12_000 }));
    expect((await resultFor('buy-stale')).data).toMatchObject({ ok: false, error: 'price_mismatch' });
  });
});

describe('passive observation only trusts real EA market responses', () => {
  it('ignores a market-shaped response from a non-EA host', async () => {
    nativeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ auctionInfo: [rawAuction(6001, 100)] })));
    await window.fetch('https://evil.example/ut/game/fc25/transfermarket');
    await settle();
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);

    deliver(await signedRequest({ action: 'buy', requestId: 'buy-offhost', tradeId: '6001', price: 100 }));
    expect((await resultFor('buy-offhost')).data).toMatchObject({ ok: false, error: 'listing_unknown' });
  });

  it('records a response from an EA host', async () => {
    const url = 'https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc25/transfermarket?num=21';
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [rawAuction(6002, 100)] }, url));
    await window.fetch(url);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(1));
  });

  it('does not record a Response with no final URL (one built in script, not by the network)', async () => {
    nativeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ auctionInfo: [rawAuction(6004, 100)] })));
    await window.fetch('https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc25/transfermarket');
    await settle();
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);

    deliver(await signedRequest({ action: 'buy', requestId: 'buy-scripted', tradeId: '6004', price: 100 }));
    expect((await resultFor('buy-scripted')).data).toMatchObject({ ok: false, error: 'listing_unknown' });
  });

  it('does not record a market response redirected off EA', async () => {
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [rawAuction(6005, 100)] }, 'https://evil.example/ut/game/fc25/transfermarket'));
    await window.fetch('https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc25/transfermarket');
    await settle();
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);
  });

  it('ignores a synthetic XHR load event carrying a forged body', async () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc25/transfermarket');
    xhr.send(); // the adapter attaches its load listener; the native send is stubbed (beforeAll)
    Object.defineProperty(xhr, 'responseText', { value: JSON.stringify({ auctionInfo: [rawAuction(6003, 100)] }) });
    xhr.dispatchEvent(new Event('load'));
    await settle();
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);
  });
});

describe('the Sniping Bot catalog', () => {
  function catalogs(): Posted[] {
    return posted.filter((m) => m.kind === 'catalog');
  }

  beforeAll(() => {
    const w = window as unknown as Record<string, unknown>;
    // The web app has started: its list factory and asset helpers exist,
    // with no `fut_*` globals, so the adapter fills an empty catalog with
    // the web app's own player list.
    w.factories = { DataProvider: {} };
    w.AssetLocationUtils = {
      FILTER: {},
      getFilterImage: () => '',
      getPlayerSearchFileUri: () => 'https://www.ea.com/fc/players.json',
      getPortraitImageUri: () => '',
    };
  });

  it('ignores a catalog request without a valid MAC', async () => {
    deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: { action: 'catalog', requestId: 'cat-no-mac' } });
    await settle();
    expect(catalogs()).toHaveLength(0);
  });

  it('answers an authenticated request with a catalog signed under the nonce', async () => {
    nativeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ Players: [{ id: 158023, f: 'Lionel', l: 'Messi', r: 88 }] })));
    deliver(await signedRequest({ action: 'catalog', requestId: 'cat-1' }));
    await vi.waitFor(() => expect(catalogs()).toHaveLength(1));
    const message = catalogs()[0]!;
    expect(message.data.catalog).toMatchObject({ players: [{ id: 158023, name: 'Lionel Messi', rating: 88 }] });
    expect(adapterCatalogMessageSchema.safeParse(message).success).toBe(true);
    expect(await signer.verify(canonicalActMessage('catalog', message.data), message.mac)).toBe(true);
    // Nothing else about it: no action_result for a catalog request.
    expect(results()).toHaveLength(0);
  });
});
