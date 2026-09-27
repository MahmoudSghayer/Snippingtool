// The Snipe Targets form's choices (model/catalog.ts). The lists themselves
// come from the EA web app's own helpers at runtime (main/adapter.ts); what
// is tested here is what this code does with them: players.json parsing,
// EA's quality -> rarity narrowing, portraits, price steps, and search.

import { describe, expect, it } from 'vitest';

import {
  fold,
  parsePlayersFile,
  portraitUrl,
  priceStep,
  raritiesForLevel,
  searchPlayers,
  type Catalog,
  type CatalogOption,
} from '../../src/model/catalog.js';

describe('players.json', () => {
  it('parses the real file shape, preferring the common name, and skips junk and duplicates', () => {
    // First entries of the FC 27 web app's players.json (2026-09-23).
    const players = parsePlayersFile({
      LegendsPlayers: [{ c: 'Iniesta', f: 'Andrés', id: 41, l: 'Iniesta Luján', r: 92 }],
      Players: [
        { f: 'Joe', id: 27, l: 'Cole', r: 87 },
        { f: 'Robbie', id: 330, l: 'Keane', r: 86 },
        { f: 'Dup', id: 27, l: 'Licate', r: 50 },
        { id: 'x', f: 'Bad' },
        { id: 5, f: '', l: '' },
      ],
    });
    expect(players).toEqual([
      { id: 27, name: 'Joe Cole', rating: 87 },
      { id: 330, name: 'Robbie Keane', rating: 86 },
      { id: 41, name: 'Iniesta', rating: 92 },
    ]);
    expect(parsePlayersFile(null)).toEqual([]);
  });
});

describe('EA list behaviour', () => {
  const rarities: CatalogOption[] = [
    { id: 0, value: '0', label: 'Common', levels: true },
    { id: 1, value: '1', label: 'Rare', levels: true },
    { id: 12, value: '12', label: 'Base Icon', levels: false },
    { id: 3, value: '3', label: 'Team of the Week', levels: false },
  ];

  it('narrows rarities by quality the way the web app does', () => {
    expect(raritiesForLevel(rarities, null).map((r) => r.id)).toEqual([0, 1, 12, 3]);
    expect(raritiesForLevel(rarities, 'gold').map((r) => r.id)).toEqual([0, 1]);
    expect(raritiesForLevel(rarities, 'SP').map((r) => r.id)).toEqual([12, 3]);
  });

  it('builds portrait URLs from the web app template', () => {
    const catalog = { portrait: 'https://www.ea.com/x/portraits/{id}.png' } as Catalog;
    expect(portraitUrl(catalog, 158023)).toBe('https://www.ea.com/x/portraits/158023.png');
    expect(portraitUrl(null, 1)).toBeNull();
  });
});

describe('form helpers', () => {
  it("steps prices the way EA's price fields do", () => {
    expect(priceStep(0, 1)).toBe(50);
    expect(priceStep(950, 1)).toBe(1_000);
    expect(priceStep(1_000, 1)).toBe(1_100);
    expect(priceStep(1_000, -1)).toBe(950);
    expect(priceStep(10_000, 1)).toBe(10_250);
    expect(priceStep(10_000, -1)).toBe(9_900);
    expect(priceStep(99_500, 1)).toBe(100_000);
    expect(priceStep(100_000, 1)).toBe(101_000);
    expect(priceStep(12_345, 1)).toBe(12_500);
    expect(priceStep(50, -1)).toBe(0);
  });

  it('searches names ignoring case and accents, word starts first, then rating', () => {
    const players = [
      { id: 1, name: 'Mbappé', rating: 91 },
      { id: 2, name: 'Ethan Mbappe', rating: 70 },
      { id: 3, name: 'Kombappez', rating: 99 },
      { id: 4, name: 'Messi', rating: 88 },
    ];
    expect(searchPlayers(players, 'mbappe').map((p) => p.id)).toEqual([1, 2, 3]);
    expect(searchPlayers(players, 'm')).toEqual([]);
    expect(fold('Nazário')).toBe('nazario');
  });
});
