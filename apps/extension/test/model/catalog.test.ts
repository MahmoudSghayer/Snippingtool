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
  playerIndex,
  raritiesForLevel,
  searchIndex,
  searchPlayers,
  type Catalog,
  type CatalogOption,
  type CatalogPlayer,
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

describe('playerIndex / searchIndex', () => {
  /** The search as it was before the index: a pass over every name. */
  function linearSearch(players: CatalogPlayer[], query: string, limit = 12): CatalogPlayer[] {
    const q = fold(query.trim());
    if (q.length < 2) return [];
    const hits: { p: CatalogPlayer; starts: boolean }[] = [];
    for (const p of players) {
      const n = fold(p.name);
      const i = n.indexOf(q);
      if (i < 0) continue;
      hits.push({ p, starts: i === 0 || n[i - 1] === ' ' });
    }
    hits.sort((a, b) => Number(b.starts) - Number(a.starts) || (b.p.rating ?? 0) - (a.p.rating ?? 0));
    return hits.slice(0, limit).map((h) => h.p);
  }

  const FIRST = ['José', 'João', 'Kylian', 'Erling', 'Mohamed', 'Rodrigo', 'Ángel', 'Jude', 'Luka', 'Lionel', 'Dušan', 'Çağlar'];
  const LAST = ['Silva', 'Rodríguez', 'Müller', 'Mbappé', 'Haaland', 'Salah', 'Bellingham', 'Modrić', 'Messi', 'Ronaldo', 'Kombappez', 'Leão'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const players: CatalogPlayer[] = Array.from({ length: 3_000 }, (_, i) => ({
    id: i + 1,
    name: rnd() < 0.1 ? LAST[Math.floor(rnd() * LAST.length)]! : `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]}${rnd() < 0.2 ? ` ${LAST[Math.floor(rnd() * LAST.length)]}` : ''}`,
    rating: rnd() < 0.05 ? null : 45 + Math.floor(rnd() * 50),
  }));

  it('gives exactly what a pass over every name gives, in the same order', () => {
    const queries = ['an', 'silva', 'mbappe', 'ald', 'bappe', 'ron', 'jose rod', 'zzqx', 'm', 'MÜLLER', 'é', 'ão', 'ic', 'modric', 'ko', 'ha', 'sa', 'es'];
    for (const q of queries) {
      expect(searchPlayers(players, q), q).toEqual(linearSearch(players, q));
      expect(searchPlayers(players, q, 3), q).toEqual(linearSearch(players, q, 3));
      expect(searchPlayers(players, q, 100), q).toEqual(linearSearch(players, q, 100));
    }
  });

  it('is built once per list and finds a player by id and by exact folded name', () => {
    const index = playerIndex(players);
    expect(playerIndex(players)).toBe(index);
    expect(index.byId.get(10)).toBe(players[9]);
    const silvas = index.byFolded.get('silva') ?? [];
    expect(silvas).toEqual(players.filter((p) => fold(p.name) === 'silva'));
    expect(playerIndex([...players])).not.toBe(index);
  });

  it('finds a mid-word match through its first bigram', () => {
    const index = playerIndex([{ id: 1, name: 'Cristiano Ronaldo', rating: 86 }]);
    expect(searchIndex(index, 'ald').map((p) => p.id)).toEqual([1]);
    expect(searchIndex(index, 'naldo').map((p) => p.id)).toEqual([1]);
    expect(searchIndex(index, 'xq')).toEqual([]);
  });
});
