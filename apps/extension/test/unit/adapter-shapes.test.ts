// Unit coverage for main/adapter.ts against each candidate EA service-layer
// shape (test/fixtures/ea-shapes.ts), and for its diagnostics action:
//   - the probe picks whichever shape the page has, and disables act with a
//     reason naming every candidate when it has neither;
//   - a search either yields normalised listings or an error — never `ok`
//     with an empty list because the envelope was not understood;
//   - a buy goes through the selected shape, after the Task 2 price
//     re-check (and, for the observable shape, a re-check against the item
//     entity itself);
//   - the diagnostics report is authenticated like any act call and carries
//     key names and types, never values.
//
// adapter.ts wires itself up at import time, so it is imported once; each
// test installs the `window.services` it wants before driving it (the probe
// reads `window.services` afresh on every act call).

import { adapterActionResultMessageSchema } from '@sl/shared';
import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_ATTRIBUTE, canonicalActMessage, createActSigner, generateNonce, type ActSigner } from '../../src/lib/act-auth.js';
import { itemEntity, observable, observableServices, promiseServices, utasAuction } from '../fixtures/ea-shapes.js';

const NONCE = generateNonce();
let signer: ActSigner;
const nativeFetch = vi.fn(async (_input: unknown) => new Response('{}'));

interface Posted {
  channel: string;
  kind: string;
  data: Record<string, unknown>;
  mac?: string;
}
let posted: Posted[] = [];
let requestSeq = 0;

function install(services: unknown): void {
  (window as unknown as { services: unknown }).services = services;
}

function deliver(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message, source: window }));
}

async function act(data: Record<string, unknown>): Promise<Posted> {
  const requestId = `req-${++requestSeq}`;
  const full = { ...data, requestId };
  const mac = await signer.sign(canonicalActMessage('act_request', full));
  deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: full, mac });
  await vi.waitFor(() => expect(posted.find((m) => m.kind === 'action_result' && m.data.requestId === requestId)).toBeDefined(), {
    timeout: 3000,
  });
  return posted.find((m) => m.kind === 'action_result' && m.data.requestId === requestId)!;
}

function lastAuctions(): Record<string, unknown>[] {
  const msgs = posted.filter((m) => m.kind === 'auctions');
  return (msgs[msgs.length - 1]?.data.auctions as Record<string, unknown>[]) ?? [];
}

function lastProbe(): Record<string, unknown> | undefined {
  const msgs = posted.filter((m) => m.kind === 'probe');
  return msgs[msgs.length - 1]?.data;
}

beforeAll(async () => {
  signer = createActSigner(NONCE)!;
  install(promiseServices().services);
  window.fetch = nativeFetch as unknown as typeof window.fetch;
  Object.defineProperty(Response.prototype, 'url', {
    configurable: true,
    get(this: { __testUrl?: string }) {
      return this.__testUrl ?? '';
    },
  });
  window.addEventListener('message', (e) => {
    const m = e.data as Posted | null;
    if (m && m.channel === ADAPTER_CHANNEL) posted.push(m);
  });
  document.documentElement.setAttribute(HANDOFF_ATTRIBUTE, NONCE);
  await import('../../src/main/adapter.js');
});

beforeEach(() => {
  posted = [];
});

describe('probe selects the service-layer shape', () => {
  it('selects the promise shape', async () => {
    install(promiseServices().services);
    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(true);
    expect(lastProbe()).toMatchObject({ ok: true, shape: 'promise' });
  });

  it('selects the observable shape', async () => {
    install(observableServices().services);
    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(true);
    expect(lastProbe()).toMatchObject({ ok: true, shape: 'observable' });
  });

  it('disables act with a reason naming each candidate when neither shape is present', async () => {
    const bid = vi.fn();
    install({ Item: { bid }, Transfer: {} });
    const search = await act({ action: 'search', filter: {} });
    expect(search.data.ok).toBe(false);
    expect(search.data.error).toMatch(/no known service-layer shape/);
    expect(search.data.error).toMatch(/promise: .*repository\.search/);
    expect(search.data.error).toMatch(/observable: .*searchTransferMarket/);
    expect(lastProbe()).toMatchObject({ ok: false });
    expect(lastProbe()?.shape).toBeUndefined();

    const buy = await act({ action: 'buy', tradeId: '1', price: 100 });
    expect(buy.data).toMatchObject({ ok: false });
    expect(buy.data.error).toMatch(/no known service-layer shape/);
    expect(bid).not.toHaveBeenCalled();
  });

  it('disables act when window.services is missing', async () => {
    install(undefined);
    const search = await act({ action: 'search', filter: {} });
    expect(search.data).toMatchObject({ ok: false });
    expect(search.data.error).toMatch(/window\.services/);
  });
});

describe('observable shape: search', () => {
  it('passes shape-specific criteria and page 1, and normalises entities', async () => {
    const svc = observableServices();
    svc.searchTransferMarket.mockReturnValueOnce(
      observable({
        success: true,
        data: {
          items: [
            itemEntity({ tradeId: 101, buyNowPrice: 9_000, resourceId: 7, rating: 86 }, { accessor: 'method', idKey: 'definitionId' }),
            itemEntity({ tradeId: 102, buyNowPrice: 9_500, resourceId: 7, rating: 86 }, { accessor: 'field', idKey: 'maskedDefId' }),
            itemEntity({ tradeId: 103, buyNowPrice: 9_900, resourceId: 7, rating: 86 }, { idKey: 'resourceId' }),
          ],
        },
      }),
    );
    install(svc.services);
    const result = await act({ action: 'search', filter: { resourceId: 7, minPrice: 1_000, maxPrice: 10_000, minRating: 85, maxRating: 87 } });
    expect(result.data.ok).toBe(true);
    const [criteria, page] = svc.searchTransferMarket.mock.calls[0]!;
    expect(page).toBe(1);
    expect(criteria).toMatchObject({ type: 'player', maskedDefId: 7, minBuy: 1_000, maxBuy: 10_000, minRating: 85, maxRating: 87 });
    expect(lastAuctions().map((a) => [a.tradeId, a.buyNow, a.resourceId, a.rating, a.buyable])).toEqual([
      ['101', 9_000, 7, 86, true],
      ['102', 9_500, 7, 86, true],
      ['103', 9_900, 7, 86, true],
    ]);
    // The search hook stands aside for the adapter's own search: one report, not two.
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(1);
  });

  it('refuses a filter field its criteria builder does not map, instead of searching wider', async () => {
    const svc = observableServices();
    install(svc.services);
    const result = await act({ action: 'search', filter: { maxPrice: 5_000, chemistryStyle: 3 } });
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toMatch(/chemistryStyle/);
    expect(svc.searchTransferMarket).not.toHaveBeenCalled();
  });
});

describe('promise shape: search', () => {
  it('normalises an auctionInfo envelope', async () => {
    const svc = promiseServices();
    svc.search.mockResolvedValueOnce({ auctionInfo: [utasAuction({ tradeId: 201, buyNowPrice: 1_100, resourceId: 5 })] });
    install(svc.services);
    expect((await act({ action: 'search', filter: { maxPrice: 2_000 } })).data.ok).toBe(true);
    expect(svc.search).toHaveBeenCalledWith(expect.objectContaining({ maxBuy: 2_000 }));
    expect(lastAuctions()).toMatchObject([{ tradeId: '201', buyNow: 1_100, resourceId: 5, buyable: true }]);
  });

  it('marks passively seen listings buyable, since it buys by tradeId', async () => {
    install(promiseServices().services);
    await act({ action: 'diagnostics' });
    const url = 'https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc26/transfermarket';
    const res = new Response(JSON.stringify({ auctionInfo: [utasAuction({ tradeId: 203, buyNowPrice: 700 })] }));
    (res as unknown as { __testUrl: string }).__testUrl = url;
    nativeFetch.mockResolvedValueOnce(res);
    await window.fetch(url);
    await vi.waitFor(() => expect(lastAuctions()).toMatchObject([{ tradeId: '203', buyable: true }]));
  });

  it('observes an observable the repository hands back instead of treating it as the result', async () => {
    const svc = promiseServices();
    svc.search.mockResolvedValueOnce(observable({ success: true, data: { items: [itemEntity({ tradeId: 202, buyNowPrice: 1_200 })] } }));
    install(svc.services);
    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(true);
    expect(lastAuctions()).toMatchObject([{ tradeId: '202', buyNow: 1_200 }]);
  });
});

describe('garbage payloads are errors, never ok with an empty list', () => {
  it.each([
    ['undefined', undefined],
    ['an object with no list', { status: 'fine' }],
    ['a non-array auctionInfo', { auctionInfo: 'nope' }],
    ['only unreadable entries', { auctionInfo: [{ junk: 1 }, { junk: 2 }] }],
  ])('promise shape: %s', async (_label, payload) => {
    const svc = promiseServices();
    svc.search.mockResolvedValueOnce(payload);
    install(svc.services);
    const result = await act({ action: 'search', filter: {} });
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toBeTruthy();
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);
  });

  it.each([
    ['success: false', { success: false, status: 461 }],
    ['no success key at all', { data: { items: [] } }],
    ['no data', { success: true }],
    ['a null item list', { success: true, data: { items: null } }],
    ['a non-object response', 'ok'],
  ])('observable shape: %s', async (_label, response) => {
    const svc = observableServices();
    svc.searchTransferMarket.mockReturnValueOnce(observable(response));
    install(svc.services);
    const result = await act({ action: 'search', filter: {} });
    expect(result.data.ok).toBe(false);
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);
  });

  it('observable shape: a search call that returns neither an observable nor a promise', async () => {
    const svc = observableServices();
    svc.searchTransferMarket.mockReturnValueOnce(undefined);
    install(svc.services);
    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(false);
  });

  it('promise shape: readResult on a garbage payload is an error, not "no longer listed"', async () => {
    const svc = promiseServices();
    svc.search.mockResolvedValueOnce({ nothing: true });
    install(svc.services);
    const result = await act({ action: 'readResult', tradeId: '1' });
    expect(result.data.ok).toBe(false);
    expect(result.data.stillListed).toBeUndefined();
  });

  it('empty results are still a successful search', async () => {
    const svc = observableServices();
    install(svc.services);
    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(true);
    expect(lastAuctions()).toEqual([]);
  });
});

describe('buy via the promise shape', () => {
  it('buys a listing it has seen at the listed price, and refuses any other price', async () => {
    const svc = promiseServices();
    svc.search.mockResolvedValueOnce({ auctionInfo: [utasAuction({ tradeId: 301, buyNowPrice: 12_000 })] });
    install(svc.services);
    await act({ action: 'search', filter: {} });

    expect((await act({ action: 'buy', tradeId: '301', price: 1_200 })).data).toMatchObject({ ok: false, error: 'price_mismatch' });
    expect(svc.buyNow).not.toHaveBeenCalled();
    expect((await act({ action: 'buy', tradeId: '301', price: 12_000 })).data).toMatchObject({ ok: true });
    expect(svc.buyNow).toHaveBeenCalledWith('301');
  });
});

describe('buy via the observable shape', () => {
  async function searchOnce(svc: ReturnType<typeof observableServices>, entity: Record<string, unknown>): Promise<void> {
    svc.searchTransferMarket.mockReturnValueOnce(observable({ success: true, data: { items: [entity] } }));
    install(svc.services);
    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(true);
  }

  it('bids the buy-now price on the very entity the search returned', async () => {
    const svc = observableServices();
    const entity = itemEntity({ tradeId: 401, buyNowPrice: 20_000 });
    await searchOnce(svc, entity);
    expect((await act({ action: 'buy', tradeId: '401', price: 20_000 })).data).toMatchObject({ ok: true });
    expect(svc.bid).toHaveBeenCalledTimes(1);
    expect(svc.bid.mock.calls[0]![0]).toBe(entity);
    expect(svc.bid.mock.calls[0]![1]).toBe(20_000);
  });

  it('refuses a price other than the one it saw listed', async () => {
    const svc = observableServices();
    await searchOnce(svc, itemEntity({ tradeId: 402, buyNowPrice: 20_000 }));
    expect((await act({ action: 'buy', tradeId: '402', price: 2_000 })).data).toMatchObject({ ok: false, error: 'price_mismatch' });
    expect(svc.bid).not.toHaveBeenCalled();
  });

  it('refuses when the entity itself now says a different price', async () => {
    const svc = observableServices();
    const entity = itemEntity({ tradeId: 403, buyNowPrice: 20_000 }, { accessor: 'field' });
    await searchOnce(svc, entity);
    entity._auction!.buyNowPrice = 25_000;
    expect((await act({ action: 'buy', tradeId: '403', price: 20_000 })).data).toMatchObject({ ok: false, error: 'price_mismatch' });
    expect(svc.bid).not.toHaveBeenCalled();
  });

  it('refuses a listing it only saw passively, since it has no entity to bid on', async () => {
    const svc = observableServices();
    install(svc.services);
    const url = 'https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc26/transfermarket';
    const res = new Response(JSON.stringify({ auctionInfo: [utasAuction({ tradeId: 404, buyNowPrice: 5_000 })] }));
    (res as unknown as { __testUrl: string }).__testUrl = url;
    nativeFetch.mockResolvedValueOnce(res);
    await window.fetch(url);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(1));
    // Content is told up front, so it never attempts it.
    expect(lastAuctions()).toMatchObject([{ tradeId: '404', buyable: false }]);

    expect((await act({ action: 'buy', tradeId: '404', price: 5_000 })).data).toMatchObject({ ok: false, error: 'listing_entity_unknown' });
    expect(svc.bid).not.toHaveBeenCalled();
  });

  it.each([
    ['success: false', observable({ success: false, status: 470 })],
    ['a bare value', { done: true }],
    ['undefined', undefined],
  ])('reports a failed buy when bid answers %s', async (_label, answer) => {
    const svc = observableServices();
    await searchOnce(svc, itemEntity({ tradeId: 405, buyNowPrice: 3_000 }));
    svc.bid.mockReturnValueOnce(answer);
    const result = await act({ action: 'buy', tradeId: '405', price: 3_000 });
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toBeTruthy();
  });

  it('fails loud on readResult, which it has no verified call for', async () => {
    install(observableServices().services);
    const result = await act({ action: 'readResult', tradeId: '1' });
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toMatch(/readResult/);
  });
});

describe('observable shape: the human\'s own searches', () => {
  it('records the entities of a search the page runs itself, so its listings are buyable', async () => {
    const svc = observableServices();
    install(svc.services);
    // Any act call runs the probe, which installs the search hook.
    await act({ action: 'diagnostics' });
    posted = [];

    const entity = itemEntity({ tradeId: 601, buyNowPrice: 4_000 });
    const pageObservable = observable({ success: true, data: { items: [entity] } });
    svc.searchTransferMarket.mockReturnValueOnce(pageObservable);
    const pageCallback = vi.fn();
    // What EA's own UI does when the human clicks Search:
    const returned = (svc.services.Item.searchTransferMarket as (c: unknown, p: number) => typeof pageObservable)({ maxBuy: 5_000 }, 1);
    expect(returned).toBe(pageObservable);
    returned.observe({}, pageCallback);

    await vi.waitFor(() => expect(pageCallback).toHaveBeenCalledWith(pageObservable, { success: true, data: { items: [entity] } }));
    // The hook reports no search of its own (passive observation does
    // that): only which listings became buyable.
    await vi.waitFor(() => expect(posted.find((m) => m.kind === 'listings_buyable')?.data).toEqual({ tradeIds: ['601'] }));
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);
    expect(svc.searchTransferMarket).toHaveBeenCalledWith({ maxBuy: 5_000 }, 1);

    expect((await act({ action: 'buy', tradeId: '601', price: 4_000 })).data).toMatchObject({ ok: true });
    expect(svc.bid.mock.calls[0]![0]).toBe(entity);
  });

  it('leaves the page\'s search alone when the response is not one it can read', async () => {
    const svc = observableServices();
    install(svc.services);
    await act({ action: 'diagnostics' });
    posted = [];
    const pageObservable = observable({ success: false, status: 500 });
    svc.searchTransferMarket.mockReturnValueOnce(pageObservable);
    const pageCallback = vi.fn();
    (svc.services.Item.searchTransferMarket as (c: unknown, p: number) => typeof pageObservable)({}, 1).observe({}, pageCallback);
    await vi.waitFor(() => expect(pageCallback).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(0);
  });

  it('reports the hook in diagnostics', async () => {
    install(observableServices().services);
    await act({ action: 'diagnostics' });
    const report = (await act({ action: 'diagnostics' })).data.diagnostics as { globals: Record<string, string> };
    expect(report.globals.searchHook).toBe('installed');
  });
});

describe('one search is one search, whichever paths saw it', () => {
  const MARKET = 'https://utas.mob.v4.prd.futc-ext.gcp.ea.com/ut/game/fc26/transfermarket';

  /** The observable-shape service as the real page would behave: the call
   * sends the market request (seen by passive observation) and answers
   * through the observable (seen by the hook, or by an act search). */
  function networkBackedServices(tradeIds: number[], networkFirst: boolean) {
    const svc = observableServices();
    svc.searchTransferMarket.mockImplementation(() => {
      const res = new Response(JSON.stringify({ auctionInfo: tradeIds.map((t) => utasAuction({ tradeId: t, buyNowPrice: 1_000 })) }));
      (res as unknown as { __testUrl: string }).__testUrl = MARKET;
      nativeFetch.mockResolvedValueOnce(res);
      const items = tradeIds.map((t) => itemEntity({ tradeId: t, buyNowPrice: 1_000 }));
      const obs = {
        observe: vi.fn((scope: unknown, cb: (sender: unknown, response: unknown) => void) => {
          setTimeout(() => cb.call(scope, obs, { success: true, data: { items } }), networkFirst ? 30 : 0);
        }),
        unobserve: vi.fn(),
      };
      setTimeout(() => void window.fetch(MARKET), networkFirst ? 0 : 30);
      return obs;
    });
    return svc;
  }

  /** content's adapter client, fed every message the adapter posts. jsdom's
   * `postMessage` leaves `event.source` unset, which the client rightly
   * refuses, so the adapter's messages are relayed to it through a
   * stand-in target. */
  async function countingClient() {
    const { createAdapterClient } = await import('../../src/content/adapter-client.js');
    const { countObservedSearches } = await import('../../src/engine/search.js');
    const target = Object.assign(new EventTarget(), { location: window.location, postMessage: () => undefined });
    window.addEventListener('message', (e) => {
      const m = e.data as Posted | null;
      if (!m || m.channel !== ADAPTER_CHANNEL || m.kind === 'act_request') return;
      target.dispatchEvent(Object.assign(new Event('message'), { data: m, source: target }));
    });
    const client = createAdapterClient(target as unknown as Window, NONCE);
    const governor = { recordObservedSearch: vi.fn() };
    const batches: unknown[][] = [];
    client.onAuctions((a) => batches.push(a));
    countObservedSearches(client, () => governor as never);
    return { client, governor, batches };
  }

  it.each([true, false])('a human search seen by both the hook and passive observation counts once (network first: %s)', async (networkFirst) => {
    const ids = networkFirst ? [701, 702] : [711, 712];
    const svc = networkBackedServices(ids, networkFirst);
    install(svc.services);
    await act({ action: 'diagnostics' });
    const { client, governor, batches } = await countingClient();
    posted = [];

    (svc.services.Item.searchTransferMarket as (c: unknown, p: number) => { observe: (s: unknown, cb: () => void) => void })({}, 1).observe({}, () => undefined);
    await vi.waitFor(() => expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(1));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));

    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(1);
    expect(batches).toHaveLength(1);
    expect(governor.recordObservedSearch).toHaveBeenCalledTimes(1);
    // ...and both listings end up buyable, one way or the other.
    const buyable = new Set<string>();
    for (const m of posted) {
      if (m.kind === 'auctions') for (const a of m.data.auctions as { tradeId: string; buyable?: boolean }[]) if (a.buyable) buyable.add(a.tradeId);
      if (m.kind === 'listings_buyable') for (const t of m.data.tradeIds as string[]) buyable.add(t);
    }
    expect([...buyable].sort()).toEqual(ids.map(String));
    client.dispose();
  });

  it.each([true, false])('an act search the network also saw counts once (network first: %s)', async (networkFirst) => {
    // Distinct tradeIds per run: the same result set within 5 s is one search.
    const svc = networkBackedServices(networkFirst ? [801] : [811], networkFirst);
    install(svc.services);
    const { client, governor, batches } = await countingClient();
    posted = [];

    expect((await act({ action: 'search', filter: {} })).data.ok).toBe(true);
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));

    expect(posted.filter((m) => m.kind === 'auctions')).toHaveLength(1);
    expect(batches).toHaveLength(1);
    expect(governor.recordObservedSearch).toHaveBeenCalledTimes(1);
    client.dispose();
  });
});

describe('diagnostics', () => {
  const SECRETS = {
    email: 'someone.real@example.com',
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    coins: 7_654_321,
    sid: '3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
  };

  function secretServices() {
    const svc = observableServices();
    const services = {
      ...svc.services,
      User: { email: SECRETS.email, accessToken: SECRETS.token, coins: SECRETS.coins, getUser: () => ({ email: SECRETS.email }) },
      Session: { sid: SECRETS.sid, nucleusId: 1234567890123 },
    };
    return { ...svc, services };
  }

  async function diagnostics(): Promise<Posted> {
    return act({ action: 'diagnostics' });
  }

  it('answers a signed request with a signed report that survives content-side validation', async () => {
    install(secretServices().services);
    const result = await diagnostics();
    expect(result.data.ok).toBe(true);
    const parsed = adapterActionResultMessageSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    // The MAC must verify over what content sees after zod parsing.
    expect(await signer.verify(canonicalActMessage('action_result', parsed.data!.data), result.mac)).toBe(true);
  });

  it('ignores an unsigned diagnostics request', async () => {
    deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: { action: 'diagnostics', requestId: 'unsigned-diag' } });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
    expect(posted.find((m) => m.kind === 'action_result' && m.data.requestId === 'unsigned-diag')).toBeUndefined();
  });

  it('reports the probe, the selected shape, key names, the last market response shape and the log', async () => {
    const svc = secretServices();
    svc.searchTransferMarket.mockReturnValueOnce(
      observable({ success: true, data: { items: [itemEntity({ tradeId: 501, buyNowPrice: 800 })] }, credits: SECRETS.coins }),
    );
    install(svc.services);
    await act({ action: 'search', filter: {} });
    const report = (await diagnostics()).data.diagnostics as Record<string, any>;

    expect(report.probe).toMatchObject({ ok: true, shape: 'observable' });
    expect(report.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ shape: 'observable', present: true }), expect.objectContaining({ shape: 'promise', present: false })]),
    );
    expect(report.servicesKeys.Item).toMatchObject({ searchTransferMarket: 'function', bid: 'function' });
    expect(report.servicesKeys.User).toMatchObject({ email: 'string', accessToken: 'string', coins: 'number' });
    expect(report.lastMarketResponse.source).toBe('act:search');
    expect(report.lastMarketResponse.shape).toMatchObject({ success: 'boolean', credits: 'number' });
    expect(report.lastMarketResponse.shape.data.items['[0]']).toMatchObject({ definitionId: 'number', getAuctionData: 'function' });
    expect(Array.isArray(report.log)).toBe(true);
    expect(report.log.length).toBeGreaterThan(0);
  });

  it('never carries a value that looks like a secret', async () => {
    const svc = secretServices();
    svc.searchTransferMarket.mockImplementationOnce(() => {
      throw new Error(`session ${SECRETS.sid} for ${SECRETS.email} rejected token ${SECRETS.token}`);
    });
    install(svc.services);
    await act({ action: 'search', filter: {} });
    const text = JSON.stringify((await diagnostics()).data.diagnostics);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(String(secret));
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/eyJ[\w-]{10,}/);
    expect(text).not.toContain('1234567890123');
  });

  it('keeps only the last 50 log lines', async () => {
    install({});
    for (let i = 0; i < 60; i++) await act({ action: 'search', filter: {} });
    const log = (await diagnostics()).data.diagnostics as { log: string[] };
    expect(log.log.length).toBe(50);
  });
});
