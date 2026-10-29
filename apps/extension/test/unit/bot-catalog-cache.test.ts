// background/bot.ts keeps the parsed catalog in memory so `catalog.get`
// validates the (up to 100k-player) catalog once, not on every call — the
// Nova panel used to poll it every 3s, and a Chrome trace showed that
// safeParse blocking the main thread ~2.4s each time. These tests pin the
// two guarantees (validate once; save updates the cache) and carry a small
// cold-vs-warm benchmark over a synthetic 50k-player catalog.

import { adapterCatalogSchema } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetCatalogCacheForTests, handleCatalogGet, handleCatalogSave } from '../../src/background/bot.js';
import { setLocal } from '../../src/lib/storage.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type { Catalog } from '../../src/model/catalog.js';

const CATALOG_KEY = 'sl.catalog.v1';

/** A valid catalog with `players` players and the given capture time. */
function catalog(capturedAt: number, players = 3): Catalog {
  return {
    players: Array.from({ length: players }, (_, i) => ({ id: i + 1, name: `Player ${i + 1}`, rating: 90 })),
    levels: [],
    rarities: [],
    positions: [],
    playStyles: [],
    nations: [],
    leagues: [],
    clubs: {},
    capturedAt,
  };
}

describe('background/bot.ts: the catalog is parsed once and cached', () => {
  useRealChromeStorage();

  beforeEach(() => {
    __resetCatalogCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetCatalogCacheForTests();
  });

  it('(a) validates the stored catalog once across repeated catalog.get', async () => {
    await setLocal(CATALOG_KEY, catalog(1));
    const safeParse = vi.spyOn(adapterCatalogSchema, 'safeParse');

    const first = await handleCatalogGet();
    const second = await handleCatalogGet();

    expect(safeParse).toHaveBeenCalledTimes(1);
    expect(first?.capturedAt).toBe(1);
    expect(second).toEqual(first);
  });

  it('(b) catalog.save updates the cache, so the next get returns it without reading storage', async () => {
    await setLocal(CATALOG_KEY, catalog(1));
    await handleCatalogGet(); // warm the cache with v1

    await handleCatalogSave(catalog(2));
    // Corrupt what is in storage: only the in-memory cache can answer now.
    await setLocal(CATALOG_KEY, null);

    const safeParse = vi.spyOn(adapterCatalogSchema, 'safeParse');
    const got = await handleCatalogGet();

    expect(got?.capturedAt).toBe(2); // from the cache the save set, not the nulled storage
    expect(safeParse).not.toHaveBeenCalled(); // no re-validation, so no storage round trip
  });

  it('benchmark: catalog.get is far faster warm than cold (50k players)', async () => {
    await setLocal(CATALOG_KEY, catalog(99, 50_000));

    const coldStart = performance.now();
    const cold = await handleCatalogGet();
    const coldMs = performance.now() - coldStart;

    const warmStart = performance.now();
    await handleCatalogGet();
    const warmMs = performance.now() - warmStart;

    // eslint-disable-next-line no-console
    console.log(`[bench] catalog.get, 50k players — cold ${coldMs.toFixed(1)}ms, warm ${warmMs.toFixed(3)}ms`);
    expect(cold?.players.length).toBe(50_000);
    expect(warmMs).toBeLessThan(coldMs);
  });
});
