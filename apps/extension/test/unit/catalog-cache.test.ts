// background/bot.ts's catalog handlers: the catalog is read from storage and
// checked against the schema once per worker life, then served from memory
// — the Nova AI page used to poll `catalog.get` every 3 s, and each answer
// re-validated 20k players and copied them to the page, which was the
// page's biggest stall (docs/06-extension.md, "Performance").

import { adapterCatalogSchema } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleCatalogGet, handleCatalogSave, invalidateCatalogCache, resetCatalogCacheForTests } from '../../src/background/bot.js';
import { setLocal } from '../../src/lib/storage.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type { Catalog } from '../../src/model/catalog.js';

useRealChromeStorage();

const catalog = (capturedAt: number): Catalog => ({
  players: [{ id: 1, name: 'Hugo Ekitiké', rating: 85 }],
  levels: [],
  rarities: [],
  positions: [],
  playStyles: [],
  nations: [],
  leagues: [],
  clubs: {},
  capturedAt,
});

const storageGets = () => (globalThis as unknown as { chrome: { storage: { local: { get: unknown } } } }).chrome.storage.local.get as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetCatalogCacheForTests();
  const local = (globalThis as unknown as { chrome: { storage: { local: { get: (...a: unknown[]) => unknown } } } }).chrome.storage.local;
  vi.spyOn(local, 'get');
});
afterEach(() => vi.restoreAllMocks());

describe('catalog.get', () => {
  it('reads storage and checks the schema once; the second call is the memory copy', async () => {
    await setLocal('sl.catalog.v1', catalog(1));
    const parse = vi.spyOn(adapterCatalogSchema, 'safeParse');
    const first = await handleCatalogGet();
    const second = await handleCatalogGet();
    expect(first?.capturedAt).toBe(1);
    expect(second).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(storageGets()).toHaveBeenCalledTimes(1);
  });

  it('remembers that storage holds nothing usable, too', async () => {
    await setLocal('sl.catalog.v1', { not: 'a catalog' });
    expect(await handleCatalogGet()).toBeNull();
    expect(await handleCatalogGet()).toBeNull();
    expect(storageGets()).toHaveBeenCalledTimes(1);
  });
});

describe('catalog.save', () => {
  it('puts the saved catalog in the cache: the next get is it, with no storage read', async () => {
    await setLocal('sl.catalog.v1', catalog(1));
    expect((await handleCatalogGet())?.capturedAt).toBe(1);
    storageGets().mockClear();
    const parse = vi.spyOn(adapterCatalogSchema, 'safeParse');
    await handleCatalogSave(catalog(2));
    expect((await handleCatalogGet())?.capturedAt).toBe(2);
    expect(storageGets()).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('another tab saving the catalog', () => {
  it('drops the memory copy when the stored catalog is a different one, and keeps it when it is the same', async () => {
    await setLocal('sl.catalog.v1', catalog(1));
    expect((await handleCatalogGet())?.capturedAt).toBe(1);
    storageGets().mockClear();
    // What this tab holds, written again (its own save echoing back): kept.
    invalidateCatalogCache(catalog(1));
    expect((await handleCatalogGet())?.capturedAt).toBe(1);
    expect(storageGets()).not.toHaveBeenCalled();
    // Another tab's newer catalog: read from storage next time.
    await setLocal('sl.catalog.v1', catalog(3));
    invalidateCatalogCache(catalog(3));
    expect((await handleCatalogGet())?.capturedAt).toBe(3);
    expect(storageGets()).toHaveBeenCalledTimes(1);
  });
});
