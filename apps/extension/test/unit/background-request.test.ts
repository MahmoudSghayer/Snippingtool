// content's calls to background (content/background-request.ts). `send`
// keeps its old contract — null for "no data", whatever the reason — for
// callers where that is safe. `request` tells "background answered" apart
// from "background did not answer", which the Sniping Bot's budget load
// needs (finding A): a dead service worker must never read as "nothing
// saved", or the next save refills every hourly budget.
import { describe, expect, it, vi } from 'vitest';

import { createBackgroundClient } from '../../src/content/background-request.js';

describe('content/background-request.ts', () => {
  it('request: an answer is ok, even a null one', async () => {
    const client = createBackgroundClient(async () => ({ ok: true, data: null }), vi.fn());
    expect(await client.request('bot.budgetGet')).toEqual({ ok: true, data: null });
  });

  it.each([
    ['no reply (a dead or reloaded service worker)', async () => undefined],
    ['a thrown sendMessage', async () => Promise.reject(new Error('Receiving end does not exist'))],
    ['an explicit refusal', async () => ({ ok: false, error: 'Invalid message payload.' })],
  ])('request: %s is not an answer', async (_label, sendMessage) => {
    const warn = vi.fn();
    const client = createBackgroundClient(sendMessage, warn);
    expect(await client.request('bot.budgetGet')).toEqual({ ok: false });
    expect(await client.send('bot.budgetGet')).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('requireAnswer rejects when background did not answer, and resolves its data when it did', async () => {
    const dead = createBackgroundClient(async () => undefined, vi.fn());
    await expect(dead.requireAnswer('bot.budgetGet')).rejects.toThrow(/bot\.budgetGet/);
    const alive = createBackgroundClient(async () => ({ ok: true, data: { x: 1 } }), vi.fn());
    await expect(alive.requireAnswer('bot.budgetGet')).resolves.toEqual({ x: 1 });
  });

  it('sends the envelope background expects', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, data: 1 }));
    await createBackgroundClient(sendMessage, vi.fn()).send('summary', { resourceId: 1 });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'summary', payload: { resourceId: 1 } });
  });
});
