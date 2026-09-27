// main/catalog-builder.ts runs in the page's MAIN world, which page scripts
// share. Its inputs are pinned: the `fut_*` globals are captured when the
// page first sets them, it fetches only https URLs on EA hosts, and it keeps
// only EA-hosted images, so the catalog content validates (strict
// `adapterCatalogSchema`, with the same host rule) is EA's.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { adapterCatalogSchema } from '@sl/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { capturePageGlobals, createCatalogBuilder, type FutGlobals } from '../../src/main/catalog-builder.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/ea-webapp');
const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));

const EA_GLOBALS: FutGlobals = {
  fut_resourceRoot: 'https://www.ea.com/',
  fut_resourceBase: 'ea-sports-fc/ultimate-team/web-app/content/',
  fut_guid: 'GUID',
  fut_year: '2027',
};

/** EA's data files by name; the players file has one player. */
function fakeGetJson() {
  return vi.fn(async (url: string): Promise<unknown> => {
    if (url.endsWith('teamconfig.json')) return read('teamconfig.min.json');
    if (url.includes('/loc/')) return read('loc-en-US.min.json');
    if (url.endsWith('futcompitemraritytunables.json')) return read('raritytunables.min.json');
    if (url.endsWith('players.json')) return { Players: [{ id: 158023, f: 'Lionel', l: 'Messi', r: 88 }] };
    throw new Error(`unexpected ${url}`);
  });
}

const page = window as unknown as Record<string, unknown>;
afterEach(() => {
  delete page.factories;
  delete page.AssetLocationUtils;
  delete page.repositories;
});

describe('capturePageGlobals', () => {
  it("pins each global at the page's first value; a later rewrite does not move it", () => {
    const win: Record<string, unknown> = {};
    const captured = capturePageGlobals(win);
    expect(captured.fut_resourceRoot).toBeUndefined();

    win.fut_resourceRoot = 'https://www.ea.com/'; // EA's bootstrap
    win.fut_guid = 'GUID';
    expect(captured).toMatchObject({ fut_resourceRoot: 'https://www.ea.com/', fut_guid: 'GUID' });

    win.fut_resourceRoot = 'https://evil.example/'; // a page script, later
    expect(captured.fut_resourceRoot).toBe('https://www.ea.com/');
    // The page's own view still works as a normal global.
    expect(win.fut_resourceRoot).toBe('https://evil.example/');
  });

  it('captures a global that was already set, and ignores non-strings', () => {
    const win: Record<string, unknown> = { fut_year: '2027', fut_guid: 42 };
    const captured = capturePageGlobals(win);
    expect(captured.fut_year).toBe('2027');
    expect(captured.fut_guid).toBeUndefined();
  });
});

describe('createCatalogBuilder', () => {
  it('builds from EA hosts, and the result passes the strict catalog schema', async () => {
    const getJson = fakeGetJson();
    const { catalog } = await createCatalogBuilder(getJson, EA_GLOBALS).refresh();
    expect(catalog!.players).toEqual([{ id: 158023, name: 'Lionel Messi', rating: 88 }]);
    expect(catalog!.nations.length).toBeGreaterThan(0);
    for (const [url] of getJson.mock.calls) expect(url.startsWith('https://www.ea.com/')).toBe(true);
    expect(adapterCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it('never fetches from a repointed resource root (off EA, or not https)', async () => {
    for (const root of ['https://evil.example/', 'http://www.ea.com/', 'https://www.ea.com.evil.example/']) {
      const getJson = fakeGetJson();
      const { catalog } = await createCatalogBuilder(getJson, { ...EA_GLOBALS, fut_resourceRoot: root }).refresh();
      expect(getJson).not.toHaveBeenCalled();
      expect(catalog!.players).toEqual([]);
      expect(catalog!.notes!.join('\n')).toContain('refused: not an https URL on an EA host');
      // Nothing it did build points off EA.
      expect(adapterCatalogSchema.safeParse(catalog).success).toBe(true);
    }
  });

  it("refuses an EA helper's player-list URL off EA", async () => {
    page.factories = { DataProvider: {} };
    page.AssetLocationUtils = {
      FILTER: {},
      getFilterImage: () => '',
      getPlayerSearchFileUri: () => 'https://evil.example/players.json',
      getPortraitImageUri: () => '',
    };
    const getJson = fakeGetJson();
    const { catalog } = await createCatalogBuilder(getJson, {}).refresh();
    expect(getJson).not.toHaveBeenCalled();
    expect(catalog!.players).toEqual([]);
    expect(catalog!.notes!.join('\n')).toContain('refused');
  });

  it("keeps only EA-hosted images from EA's list helpers", async () => {
    const entry = (id: number, label: string) => ({ id, value: String(id), label });
    page.repositories = { TeamConfig: { getNations: () => [1] } };
    page.factories = {
      DataProvider: {
        getRareItemLevelDP: () => [],
        getItemRarityDP: () => [],
        getPlayerPositionDP: () => [],
        getPlayStyleDP: () => [],
        getNationDP: () => [entry(18, 'France'), entry(52, 'Argentina')],
        getLeagueDP: () => [],
      },
    };
    page.AssetLocationUtils = {
      FILTER: { NATION: 'nation' },
      getFilterImage: (_f: string, id: unknown) =>
        id === 18 ? 'https://www.ea.com/flags/18.png' : 'https://tracker.example/52.png',
      getPlayerSearchFileUri: () => 'https://www.ea.com/players.json',
      getPortraitImageUri: () => 'https://tracker.example/p/987654321.png',
    };
    const { catalog, complete } = await createCatalogBuilder(fakeGetJson(), {}).refresh();
    expect(complete).toBe(true);
    expect(catalog!.nations).toEqual([
      { id: 18, value: '18', label: 'France', img: 'https://www.ea.com/flags/18.png' },
      { id: 52, value: '52', label: 'Argentina' },
    ]);
    expect(catalog!.portrait).toBeUndefined();
    expect(adapterCatalogSchema.safeParse(catalog).success).toBe(true);
  });
});
