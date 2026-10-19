// main/adapter.ts's `clearExpired` act (Bid mode, automation builds): the
// finished auctions the last watch list read saw that the trader did not
// win (expired, or lost to another bid) go off the watch list through the
// web app's own call, as Transfer Targets' "Clear expired" does. Never a
// won auction or one still running.
//
// adapter.ts wires itself up at import time and keeps module state, so this
// file imports its own copy, once.

import { adapterActionResultMessageSchema } from '@sl/shared';
import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_ATTRIBUTE, canonicalActMessage, createActSigner, generateNonce, type ActSigner } from '../../src/lib/act-auth.js';
import { itemEntity, observable, promiseServices } from '../fixtures/ea-shapes.js';

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

function watchServices(watched: ReturnType<typeof itemEntity>[]) {
  const requestWatchedItems = vi.fn((): unknown => observable({ success: true, data: { items: watched } }));
  const untarget = vi.fn((_items: unknown[]): unknown => observable({ success: true, data: {} }));
  return {
    services: { Item: { searchTransferMarket: vi.fn(), bid: vi.fn(), requestWatchedItems, untarget, clearTransferMarketCache: vi.fn() } },
    requestWatchedItems,
    untarget,
  };
}

const watched = (tradeId: number, tradeState: string, bidState: string) =>
  itemEntity({ tradeId, buyNowPrice: 20_000, currentBid: 10_000, tradeState, bidState, itemId: 9000 + tradeId, resourceId: 7, expires: tradeState === 'active' ? 120 : -1 });

beforeAll(async () => {
  signer = createActSigner(NONCE)!;
  install(watchServices([]).services);
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

describe('clearing expired items off the watch list', () => {
  it('takes off only what the last read saw expired or lost, signed, and never a won or running auction', async () => {
    const won = watched(1, 'closed', 'highest');
    const running = watched(2, 'active', 'highest');
    const outbidRunning = watched(3, 'active', 'outbid');
    const lost = watched(4, 'closed', 'outbid');
    const expired = watched(5, 'expired', 'none');
    const svc = watchServices([won, running, outbidRunning, lost, expired]);
    install(svc.services);
    expect((await act({ action: 'watchlist' })).data.ok).toBe(true);

    const res = await act({ action: 'clearExpired' });
    expect(res.data).toMatchObject({ action: 'clearExpired', ok: true, cleared: 2 });
    expect(adapterActionResultMessageSchema.safeParse(res).success).toBe(true);
    expect(await signer.verify(canonicalActMessage('action_result', res.data), res.mac!)).toBe(true);
    expect(svc.untarget).toHaveBeenCalledTimes(1);
    expect(svc.untarget.mock.calls[0]![0]).toEqual([lost, expired]);

    // Nothing left from that read: a second clear sends nothing to EA.
    expect((await act({ action: 'clearExpired' })).data).toMatchObject({ ok: true, cleared: 0 });
    expect(svc.untarget).toHaveBeenCalledTimes(1);
  });

  it('says so when the page has no such call, and on the promise shape', async () => {
    const svc = watchServices([]);
    const { untarget: _u, ...item } = svc.services.Item;
    install({ Item: item });
    // Nothing finished was read since the last clear: nothing to send, so
    // no call is needed yet.
    expect((await act({ action: 'clearExpired' })).data).toMatchObject({ ok: true, cleared: 0 });
    install(promiseServices().services);
    expect((await act({ action: 'clearExpired' })).data).toMatchObject({ ok: false, error: 'clear_expired_unsupported' });
  });
});
