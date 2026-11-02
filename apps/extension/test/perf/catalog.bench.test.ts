// The catalog's cost end to end: background `catalog.get` cold (storage
// read + schema check) and warm (the next call), the player search per
// keystroke, and "Load list" against EA's player list. See harness.ts.
import { afterAll, describe, expect, it } from 'vitest';

import { handleCatalogGet, handleCatalogSave } from '../../src/background/bot.js';
import { parseGalleryList } from '../../src/engine/gallery.js';
import { searchPlayers } from '../../src/model/catalog.js';
import { useRealChromeStorage } from '../unit/chrome-storage-stub.js';

import { makeCatalog, makePlayers } from './fixtures.js';
import { createSuite } from './harness.js';

useRealChromeStorage();
const suite = createSuite('catalog');
afterAll(() => suite.flush());

describe('background catalog.get', () => {
  for (const n of [20_000, 50_000]) {
    it(`cold then warm, ${n} players`, async () => {
      const catalog = makeCatalog(n);
      await handleCatalogSave(catalog);
      // Cold: the first read after a save (a fresh service worker, or the
      // catalog just saved). Warm: every read after it.
      await suite.benchAsync(
        `catalog.get cold ${n / 1000}k`,
        async () => {
          await handleCatalogSave(catalog);
          const got = await handleCatalogGet();
          expect(got?.players.length).toBe(n);
        },
        { runs: 3, warmup: 0 },
      );
      await suite.benchAsync(
        `catalog.get warm ${n / 1000}k`,
        async () => {
          const got = await handleCatalogGet();
          expect(got?.players.length).toBe(n);
        },
        { runs: 5, warmup: 1 },
      );
    }, 120_000);
  }
});

describe('player search', () => {
  for (const n of [20_000, 50_000]) {
    const players = makePlayers(n);
    const cases: [string, string][] = [
      ['common bigram "an"', 'an'],
      ['surname "silva"', 'silva'],
      ['rare "mbappe"', 'mbappe'],
      ['mid-word "ald"', 'ald'],
      ['no result "zzqx"', 'zzqx'],
      ['two words "jose rod"', 'jose rod'],
    ];
    it(`per keystroke, ${n} players`, () => {
      for (const [label, q] of cases) {
        suite.bench(`search ${n / 1000}k ${label}`, () => {
          const hits = searchPlayers(players, q);
          return { hits: hits.length };
        });
      }
      // A name typed one key at a time: the sum of ten searches.
      suite.bench(`search ${n / 1000}k typing "bellingham" (10 keys)`, () => {
        let total = 0;
        for (let i = 1; i <= 10; i++) total += searchPlayers(players, 'bellingham'.slice(0, i)).length;
        return { hits: total };
      });
    }, 120_000);
  }

  it('Load list: 300 typed lines against 20k players', () => {
    const players = makePlayers(20_000);
    const lines = players
      .slice(0, 300)
      .map((p, i) => `${p.name} ${p.rating ?? 80}${i % 3 === 0 ? ' Rare' : ''}`)
      .join('\n');
    const rarities = [{ id: 1, value: '1', label: 'Rare' }];
    const r = suite.bench('parseGalleryList 300 lines / 20k', () => {
      const out = parseGalleryList(lines, players, [], rarities);
      return { cards: out.cards.length, problems: out.problems.length };
    }, { runs: 3 });
    expect(r.meta?.cards).toBeGreaterThan(250);
  }, 120_000);
});
