// EA's own search data (model/catalog.ts): the web app's players.json and its
// localisation file, parsed into the lists the Snipe Targets form searches.

import { describe, expect, it } from 'vitest';

import {
  LOC_FILE,
  PLAYERS_FILE,
  parseLocFile,
  parsePlayersFile,
  searchPlayers,
} from '../../src/model/catalog.js';

describe('catalog files', () => {
  it('recognises the players and localisation URLs', () => {
    expect(
      PLAYERS_FILE.test(
        'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/content/abc/2026/fut/items/web/players.json?_=1',
      ),
    ).toBe(true);
    expect(
      LOC_FILE.test('https://www.ea.com/ea-sports-fc/ultimate-team/web-app/loc/en_GB.json'),
    ).toBe(true);
    expect(PLAYERS_FILE.test('https://www.ea.com/ut/game/fc26/transfermarket')).toBe(false);
  });

  it('parses players, preferring the common name, and skips junk and duplicates', () => {
    const players = parsePlayersFile({
      Players: [
        { id: 231747, f: 'Kylian', l: 'Mbappé Lottin', c: 'Mbappé', r: 91 },
        { id: 158023, f: 'Lionel', l: 'Messi', r: 88 },
        { id: 158023, f: 'Dup', l: 'Licate', r: 50 },
        { id: 'x', f: 'Bad' },
        { id: 5, f: '', l: '' },
      ],
      LegendsPlayers: [{ id: 190042, f: 'Ronaldo', l: 'Nazário', c: 'R9', r: 95 }],
    });
    expect(players).toEqual([
      { id: 231747, name: 'Mbappé', rating: 91 },
      { id: 158023, name: 'Lionel Messi', rating: 88 },
      { id: 190042, name: 'R9', rating: 95 },
    ]);
    expect(parsePlayersFile(null)).toEqual([]);
    expect(parsePlayersFile({ nothing: [] })).toEqual([]);
  });

  it('pulls club, league and nation names out of the localisation keys', () => {
    const names = parseLocFile({
      'global.teamFull.2026.team241': 'FC Barcelona',
      'global.teamFull.2026.team10': 'Manchester City',
      'global.leagueFull.2026.league13': 'Premier League',
      'search.nationName.nation14': 'England',
      'some.other.key': 'Ignored',
    });
    expect(names.clubs).toEqual([
      { id: 241, name: 'FC Barcelona' },
      { id: 10, name: 'Manchester City' },
    ]);
    expect(names.leagues).toEqual([{ id: 13, name: 'Premier League' }]);
    expect(names.nations).toEqual([{ id: 14, name: 'England' }]);
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
  });
});
