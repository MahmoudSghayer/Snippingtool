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

function rawAuction(tradeId: number, buyNowPrice: number, card: { resourceId?: number; assetId?: number } = {}) {
  return { tradeId, buyNowPrice, startingBid: 150, currentBid: 0, offers: 0, expires: 3600, itemData: { resourceId: 42, assetId: 42, rating: 85, ...card } };
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
  async function seeListing(tradeId: number, price: number, card: { resourceId?: number; assetId?: number } = {}): Promise<void> {
    search.mockResolvedValueOnce({ auctionInfo: [rawAuction(tradeId, price, card)] });
    const requestId = `see-${tradeId}-${price}-${card.resourceId ?? 42}-${card.assetId ?? 42}`;
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

  it('buys the card under any id EA gave the same listing, and still refuses any other card', async () => {
    // One listing read twice (an act result's item entity and the network
    // response it caused can name the card differently); content may have
    // been told either reading.
    await seeListing(5007, 52_000, { resourceId: 50_331_842, assetId: 228_702 });
    await seeListing(5007, 52_000, { resourceId: 228_702, assetId: 228_702 });
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-other-card', tradeId: '5007', price: 52_000, resourceId: 77 }));
    expect((await resultFor('buy-other-card')).data).toMatchObject({ ok: false, error: 'resource_mismatch' });
    expect(buyNow).not.toHaveBeenCalled();

    deliver(await signedRequest({ action: 'buy', requestId: 'buy-first-reading', tradeId: '5007', price: 52_000, resourceId: 50_331_842, assetId: 228_702 }));
    expect((await resultFor('buy-first-reading')).data).toMatchObject({ ok: true });
    deliver(await signedRequest({ action: 'buy', requestId: 'buy-latest-reading', tradeId: '5007', price: 52_000, resourceId: 228_702, assetId: 228_702 }));
    expect((await resultFor('buy-latest-reading')).data).toMatchObject({ ok: true });
    expect(buyNow).toHaveBeenCalledTimes(2);
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

// Nova AI's wallet: the coin balance EA's own answers state (`credits`),
// since EA's top bar is not always redrawn after the bot's buys and sales.
describe("the coin balance from EA's answers", () => {
  const EA = 'https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc25';
  const credits = () => posted.filter((m) => m.kind === 'credits');

  it('sends the balance a market, trade-pile or buy answer states, signed, once per change', async () => {
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [], credits: 423_244 }, EA + '/transfermarket?num=21'));
    await window.fetch(EA + '/transfermarket?num=21');
    await vi.waitFor(() => expect(credits()).toHaveLength(1));
    const first = credits()[0]!;
    expect(first.data).toMatchObject({ credits: 423_244 });
    expect(await signer.verify(canonicalActMessage('credits', first.data), first.mac)).toBe(true);

    // The same balance again: nothing new to say.
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [], credits: 423_244 }, EA + '/transfermarket?num=21'));
    await window.fetch(EA + '/transfermarket?num=21');
    await settle();
    expect(credits()).toHaveLength(1);

    // A buy's answer: read for its balance only.
    const before = posted.filter((m) => m.kind === 'auctions' || m.kind === 'tradepile').length;
    nativeFetch.mockResolvedValueOnce(networkResponse({ credits: 421_044, auctionInfo: [rawAuction(6101, 2_200)] }, EA + '/trade/6101/bid'));
    await window.fetch(EA + '/trade/6101/bid', { method: 'PUT' });
    await vi.waitFor(() => expect(credits()).toHaveLength(2));
    expect(credits()[1]!.data).toMatchObject({ credits: 421_044 });
    expect(posted.filter((m) => m.kind === 'auctions' || m.kind === 'tradepile')).toHaveLength(before);

    // A sale, seen on the next trade-pile load.
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [], credits: 422_849 }, EA + '/tradepile'));
    await window.fetch(EA + '/tradepile');
    await vi.waitFor(() => expect(credits()).toHaveLength(3));
    expect(credits()[2]!.data).toMatchObject({ credits: 422_849 });
  });

  it('ignores a balance from anywhere but EA, and one that is not a whole number', async () => {
    nativeFetch.mockResolvedValueOnce(networkResponse({ credits: 999_999_999 }, 'https://evil.example/ut/game/fc25/trade/1/bid'));
    await window.fetch('https://evil.example/ut/game/fc25/trade/1/bid', { method: 'PUT' });
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [], credits: '5' }, EA + '/transfermarket'));
    await window.fetch(EA + '/transfermarket');
    await settle();
    expect(credits()).toHaveLength(0);
  });
});

// Defect C13: the trader's own trade pile, read passively like the market
// (same https + *.ea.com check), and posted as its own `tradepile`
// message, never as a search.
describe('passive observation of the trade pile', () => {
  const EA = 'https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc25';
  function pileEntry(itemId: number, tradeState: string | null, currentBid = 0) {
    return {
      tradeId: tradeState ? 7000 + itemId : 0,
      buyNowPrice: 14_000,
      startingBid: 13_000,
      currentBid,
      offers: 0,
      expires: 0,
      tradeState,
      itemData: { id: itemId, resourceId: 42, assetId: 42, rating: 88 },
    };
  }

  for (const path of ['/tradepile', '/auctionhouse/relist', '/item']) {
    it(`posts the items of an EA ${path.split('?')[0]} response`, async () => {
      const url = EA + path;
      nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [pileEntry(11, 'closed', 13_500), pileEntry(12, null)] }, url));
      await window.fetch(url);
      await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(1));
      const message = posted.find((m) => m.kind === 'tradepile')!;
      expect(message.data.items).toEqual([
        expect.objectContaining({ itemId: '11', tradeState: 'closed', currentBid: 13_500 }),
        expect.objectContaining({ itemId: '12', tradeState: null, tradeId: null }),
      ]);
      expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);
    });
  }

  // Won and bought auctions show there as `closed` at the price paid: a
  // purchase, never a sale (review finding C1).
  for (const path of ['/watchlist', '/trade/status?tradeIds=5001']) {
    it(`never reads ${path.split('?')[0]}: a bought auction there is not a sale`, async () => {
      const url = EA + path;
      nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [pileEntry(15, 'closed', 10_000)] }, url));
      await window.fetch(url);
      await settle();
      expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(0);
    });
  }

  it('marks a plain GET of the trade pile as the full pile, even when empty, and nothing else', async () => {
    const url = EA + '/tradepile';
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [] }, url));
    await window.fetch(url);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(1));
    expect(posted.find((m) => m.kind === 'tradepile')!.data).toMatchObject({ items: [], full: true });

    posted = [];
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [pileEntry(16, 'active')] }, url));
    await window.fetch(url, { method: 'PUT' });
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(1));
    expect(posted.find((m) => m.kind === 'tradepile')!.data.full).toBe(false);

    posted = [];
    const relist = EA + '/auctionhouse/relist';
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [pileEntry(17, 'active')] }, relist));
    await window.fetch(relist);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(1));
    expect(posted.find((m) => m.kind === 'tradepile')!.data.full).toBe(false);
  });

  it('does not call a trade pile full when it skipped an unreadable entry, nor drop it for one bad price', async () => {
    const url = EA + '/tradepile';
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [pileEntry(18, 'active'), { something: 'else' }, { ...pileEntry(19, 'active'), buyNowPrice: 99_000_000 }] }, url));
    await window.fetch(url);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(1));
    const data = posted.find((m) => m.kind === 'tradepile')!.data;
    expect(data.full).toBe(false);
    expect((data.items as { itemId: string }[]).map((i) => i.itemId)).toEqual(['18']);
  });

  it('ignores a trade-pile-shaped response from a non-EA host', async () => {
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [pileEntry(13, 'closed', 13_500)] }, 'https://evil.example/ut/game/fc25/tradepile'));
    await window.fetch('https://evil.example/ut/game/fc25/tradepile');
    await settle();
    expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(0);
  });

  it('reports a shape change for a trade pile none of whose entries it can read', async () => {
    const url = EA + '/tradepile';
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [{ something: 'else' }] }, url));
    await window.fetch(url);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'shape')).toHaveLength(1));
    expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(0);
  });

  it('puts the last trade-pile response, keys and types only, in the diagnostics report', async () => {
    const url = EA + '/tradepile';
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [pileEntry(14, 'active')], credits: 123456 }, url));
    await window.fetch(url);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'tradepile')).toHaveLength(1));
    deliver(await signedRequest({ action: 'diagnostics', requestId: 'diag-pile' }));
    const report = (await resultFor('diag-pile')).data.diagnostics as { lastTradePileResponse: { path: string; shape: Record<string, unknown> } };
    expect(report.lastTradePileResponse.path).toBe('/ut/game/fc25/tradepile');
    expect(report.lastTradePileResponse.shape).toMatchObject({ credits: 'number' });
    expect(JSON.stringify(report)).not.toContain('123456');
  });

  it('carries the item id on a market listing', async () => {
    const url = EA + '/transfermarket?num=21';
    nativeFetch.mockResolvedValueOnce(networkResponse({ auctionInfo: [{ ...rawAuction(6100, 100), itemData: { id: 555, resourceId: 42, assetId: 42, rating: 85 } }] }, url));
    await window.fetch(url);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(1));
    expect((posted.find((m) => m.kind === 'auctions')!.data.auctions as { itemId?: string }[])[0]!.itemId).toBe('555');
  });

  it('carries the card name from the item data, trimmed and bounded (the panel shows it)', async () => {
    const url = EA + '/transfermarket?num=21';
    nativeFetch.mockResolvedValueOnce(
      networkResponse(
        {
          auctionInfo: [
            { ...rawAuction(6101, 100), itemData: { id: 556, resourceId: 42, assetId: 42, rating: 85, name: '  Erling Haaland\u0000 ' } },
            { ...rawAuction(6102, 100), itemData: { id: 557, resourceId: 43, assetId: 43, rating: 85, name: 'x'.repeat(200) } },
            { ...rawAuction(6103, 100), itemData: { id: 558, resourceId: 44, assetId: 44, rating: 85 } },
          ],
        },
        url,
      ),
    );
    await window.fetch(url);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(1));
    const names = (posted.find((m) => m.kind === 'auctions')!.data.auctions as { name?: string }[]).map((a) => a.name);
    expect(names[0]).toBe('Erling Haaland');
    expect(names[1]).toHaveLength(80);
    expect(names[2]).toBeUndefined();
  });
});
