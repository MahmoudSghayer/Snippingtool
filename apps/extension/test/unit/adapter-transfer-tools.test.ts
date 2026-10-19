// main/adapter.ts's acts for the Nova AI page's Transfer list card
// (automation builds): EA's own Clear Sold and Re-list All, each followed by
// a reload of the transfer list; a read of the list's unsold cards; and a
// relist at new prices of only a card that read returned, once.
//
// adapter.ts wires itself up at import time and keeps module state, so this
// file imports its own copy, once.

import { adapterActionResultMessageSchema } from '@sl/shared';
import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_ATTRIBUTE, canonicalActMessage, createActSigner, generateNonce, type ActSigner } from '../../src/lib/act-auth.js';
import { itemEntity, observable } from '../fixtures/ea-shapes.js';

const NONCE = generateNonce();
let signer: ActSigner;

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
  await vi.waitFor(() => expect(posted.find((m) => m.kind === 'action_result' && m.data.requestId === requestId)).toBeDefined(), { timeout: 3000 });
  return posted.find((m) => m.kind === 'action_result' && m.data.requestId === requestId)!;
}

async function actIgnored(data: Record<string, unknown>): Promise<boolean> {
  const requestId = `req-${++requestSeq}`;
  const full = { ...data, requestId };
  deliver({ channel: ADAPTER_CHANNEL, kind: 'act_request', data: full, mac: await signer.sign(canonicalActMessage('act_request', full)) });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
  return posted.every((m) => m.kind !== 'action_result' || m.data.requestId !== requestId);
}

/** The observable shape with the transfer list calls. */
function pileServices(pile: ReturnType<typeof itemEntity>[] = []) {
  const succeed = (): unknown => observable({ success: true, data: {} });
  const requestTransferItems = vi.fn((): unknown => observable({ success: true, data: { items: pile } }));
  const clearSoldItems = vi.fn(succeed);
  const relistExpiredAuctions = vi.fn(succeed);
  const list = vi.fn((_item: unknown, _s: number, _b: number, _d: number): unknown => observable({ success: true, data: {} }));
  return {
    services: {
      Item: { searchTransferMarket: vi.fn(), bid: vi.fn(), requestTransferItems, clearSoldItems, relistExpiredAuctions, list, clearTransferMarketCache: vi.fn() },
    },
    requestTransferItems,
    clearSoldItems,
    relistExpiredAuctions,
    list,
  };
}

const pileCard = (itemId: number, tradeState: string, buyNowPrice = 2_100) =>
  itemEntity({ tradeId: 700 + itemId, itemId, buyNowPrice, tradeState, resourceId: 20801, expires: 0 });

beforeAll(async () => {
  signer = createActSigner(NONCE)!;
  install(pileServices().services);
  window.fetch = vi.fn(async () => new Response('{}')) as unknown as typeof window.fetch;
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

describe('Clear sold and Re-list All', () => {
  it("use EA's own calls, answer signed, then reload the transfer list", async () => {
    const svc = pileServices();
    install(svc.services);
    const cleared = await act({ action: 'clearSold' });
    expect(cleared.data).toMatchObject({ action: 'clearSold', ok: true });
    expect(adapterActionResultMessageSchema.safeParse(cleared).success).toBe(true);
    expect(await signer.verify(canonicalActMessage('action_result', cleared.data), cleared.mac!)).toBe(true);
    expect(svc.clearSoldItems).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(svc.requestTransferItems).toHaveBeenCalledTimes(1));

    expect((await act({ action: 'relistAll' })).data).toMatchObject({ action: 'relistAll', ok: true });
    expect(svc.relistExpiredAuctions).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(svc.requestTransferItems).toHaveBeenCalledTimes(2));
  });

  it('say so when EA refuses, and reload nothing', async () => {
    const svc = pileServices();
    svc.clearSoldItems.mockReturnValueOnce(observable({ success: false, status: 460 }));
    install(svc.services);
    expect((await act({ action: 'clearSold' })).data).toMatchObject({ ok: false });
    expect(svc.requestTransferItems).not.toHaveBeenCalled();
  });

  it('name the missing call on a page without it', async () => {
    const svc = pileServices();
    const { clearSoldItems: _c, relistExpiredAuctions: _r, ...item } = svc.services.Item;
    install({ Item: item });
    expect((await act({ action: 'clearSold' })).data).toMatchObject({ ok: false, error: 'window.services.Item.clearSoldItems is not a function' });
    expect((await act({ action: 'relistAll' })).data).toMatchObject({ ok: false, error: 'window.services.Item.relistExpiredAuctions is not a function' });
  });
});

describe('Relist unsold at new prices', () => {
  it("reads the list's unsold cards, then lists only those, each once, on the very entity EA returned", async () => {
    const expired = pileCard(11, 'expired');
    const svc = pileServices([pileCard(10, 'closed'), expired, pileCard(12, 'active'), pileCard(13, 'expired', 900)]);
    install(svc.services);
    const read = await act({ action: 'unsold' });
    expect(read.data).toMatchObject({ action: 'unsold', ok: true });
    expect(adapterActionResultMessageSchema.safeParse(read).success).toBe(true);
    expect((read.data.unsold as { itemId: string; buyNowPrice: number }[]).map((c) => [c.itemId, c.buyNowPrice])).toEqual([
      ['11', 2_100],
      ['13', 900],
    ]);

    expect((await act({ action: 'relist', itemId: '11', startPrice: 1_900, buyNowPrice: 2_000 })).data).toMatchObject({ action: 'relist', ok: true });
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(svc.list.mock.calls[0]![0]).toBe(expired);
    expect(svc.list.mock.calls[0]!.slice(1)).toEqual([1_900, 2_000, 3600]);
    // Once only, and never a card that was not unsold.
    expect((await act({ action: 'relist', itemId: '11', startPrice: 1_900, buyNowPrice: 2_000 })).data).toMatchObject({ ok: false, error: 'relist_not_unsold' });
    expect((await act({ action: 'relist', itemId: '12', startPrice: 1_900, buyNowPrice: 2_000 })).data).toMatchObject({ ok: false, error: 'relist_not_unsold' });
    expect((await act({ action: 'relist', itemId: '10', startPrice: 1_900, buyNowPrice: 2_000 })).data).toMatchObject({ ok: false, error: 'relist_not_unsold' });
    expect(svc.list).toHaveBeenCalledTimes(1);
  });

  it('drops a relist whose prices EA would not take', async () => {
    install(pileServices([pileCard(21, 'expired')]).services);
    await act({ action: 'unsold' });
    expect(await actIgnored({ action: 'relist', itemId: '21', startPrice: 2_000, buyNowPrice: 2_000 })).toBe(true);
    expect(await actIgnored({ action: 'relist', itemId: '21', startPrice: 100, buyNowPrice: 2_000 })).toBe(true);
    expect(await actIgnored({ action: 'relist', itemId: '', startPrice: 1_900, buyNowPrice: 2_000 })).toBe(true);
  });
});
