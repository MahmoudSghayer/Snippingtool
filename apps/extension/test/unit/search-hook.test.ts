// Unit coverage for main/search-hook.ts on its own: it wraps
// services.Item.searchTransferMarket once, re-installs when the page swaps
// the function or the Item object, hands the page the original observable,
// and stands aside inside `unhooked`.

import { describe, expect, it, vi } from 'vitest';

import { createSearchHook } from '../../src/main/search-hook.js';
import { observable } from '../fixtures/ea-shapes.js';

function services() {
  const search = vi.fn((_c: unknown, _p: number) => observable({ success: true, data: { items: [] } }));
  return { services: { Item: { searchTransferMarket: search as unknown } }, search };
}

describe('createSearchHook', () => {
  it('wraps once: ensure is idempotent, and the page still gets the original observable', async () => {
    const onResponse = vi.fn();
    const hook = createSearchHook(onResponse);
    const { services: svc, search } = services();
    expect(hook.ensure(svc)).toBe(true);
    const wrapped = svc.Item.searchTransferMarket;
    expect(hook.ensure(svc)).toBe(true);
    expect(svc.Item.searchTransferMarket).toBe(wrapped);

    const returned = (wrapped as (c: unknown, p: number) => unknown)({ a: 1 }, 1);
    expect(returned).toBe(search.mock.results[0]!.value);
    expect(search).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledTimes(1));
  });

  it('re-installs when the page replaces the function or the Item object', () => {
    const hook = createSearchHook(vi.fn());
    const { services: svc } = services();
    hook.ensure(svc);
    const first = svc.Item.searchTransferMarket;

    svc.Item.searchTransferMarket = vi.fn();
    expect(hook.isInstalled(svc)).toBe(false);
    expect(hook.ensure(svc)).toBe(true);
    expect(svc.Item.searchTransferMarket).not.toBe(first);

    svc.Item = { searchTransferMarket: vi.fn() as unknown };
    expect(hook.isInstalled(svc)).toBe(false);
    expect(hook.ensure(svc)).toBe(true);
    expect(hook.isInstalled(svc)).toBe(true);
  });

  it('stands aside for calls made inside unhooked', async () => {
    const onResponse = vi.fn();
    const hook = createSearchHook(onResponse);
    const { services: svc } = services();
    hook.ensure(svc);
    hook.unhooked(() => (svc.Item.searchTransferMarket as (c: unknown, p: number) => unknown)({}, 1));
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('leaves a non-writable function alone', () => {
    const hook = createSearchHook(vi.fn());
    const item = {};
    const original = vi.fn();
    Object.defineProperty(item, 'searchTransferMarket', { value: original, writable: false });
    expect(hook.ensure({ Item: item })).toBe(false);
    expect((item as { searchTransferMarket: unknown }).searchTransferMarket).toBe(original);
  });
});
