// catalog-static.ts against trimmed copies of the EA web app's real public
// files (test/fixtures/ea-webapp): the lists must come out the way the web
// app's own search panel shows them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildStaticLists } from '../../src/model/catalog-static.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/ea-webapp');
const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));

const ROOT = 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/content/GUID/2027/fut/';
const WEB = 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/';
const lists = buildStaticLists({
  root: ROOT,
  web: WEB,
  year: '2027',
  teamConfig: read('teamconfig.min.json'),
  loc: read('loc-en-US.min.json'),
  rarityTunables: read('raritytunables.min.json'),
});

describe('lists built from the web app files', () => {
  it('qualities with EA level badges', () => {
    expect(lists.levels.map((l) => [l.value, l.label])).toEqual([
      ['bronze', 'Bronze'],
      ['silver', 'Silver'],
      ['gold', 'Gold'],
      ['SP', 'Special'],
    ]);
    expect(lists.levels[2]!.img).toBe(`${WEB}images/SearchFilters/level/gold.png`);
  });

  it('rarities: Common and Rare first, then designs A-Z, with card art', () => {
    const labels = lists.rarities.map((r) => r.label);
    expect(labels.slice(0, 2)).toEqual(['Common', 'Rare']);
    const rest = labels.slice(2);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
    expect(lists.rarities[0]!.img).toBe(
      // Common has its own design guid in the tunables, which EA's image path uses.
      `${ROOT}items/images/backgrounds/itemBGs/929f3299-a61e-4ff1-abda-7663f1c835db/cards_bg_e_1_0_3.png`,
    );
    const otw = lists.rarities.find((r) => r.label === 'Ones to Watch')!;
    expect(otw.img).toBe(
      `${ROOT}items/images/backgrounds/itemBGs/1a383901-e6ff-46fa-8d50-2e2e79ff270a/cards_bg_e_1_150_0.png`,
    );
    expect(otw.levels).toBe(false);
  });

  it('positions: the three groups, then each searchable position', () => {
    expect(lists.positions.map((p) => p.label)).toEqual([
      'Defenders',
      'Midfielders',
      'Attackers',
      'GK',
      'RB',
      'CB',
      'LB',
      'CDM',
      'RM',
      'CM',
      'LM',
      'CAM',
      'RW',
      'ST',
      'LW',
    ]);
    expect(lists.positions.find((p) => p.label === 'ST')).toMatchObject({
      id: 25,
      value: 'ST',
      img: `${ROOT}items/images/mobile/positions/25.png`,
    });
    expect(lists.positions[0]).toMatchObject({ id: 130, value: '130' });
  });

  it('all 24 chemistry styles with icons', () => {
    expect(lists.playStyles).toHaveLength(24);
    expect(lists.playStyles[0]).toMatchObject({
      id: 250,
      label: 'Basic',
      img: `${ROOT}items/images/mobile/chemistrystyles/list/250.png`,
    });
  });

  it("nations: EA's top nine first, then A-Z, with flags", () => {
    expect(lists.nations.slice(0, 9).map((n) => n.label)).toEqual([
      'Argentina',
      'Brazil',
      'England',
      'France',
      'Germany',
      'Netherlands',
      'Italy',
      'Portugal',
      'Spain',
    ]);
    const rest = lists.nations.slice(9).map((n) => n.label);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
    expect(lists.nations.find((n) => n.label === 'France')!.img).toBe(
      `${ROOT}items/images/mobile/flags/dark/18.png`,
    );
  });

  it('leagues: top leagues first, labelled "Name (ABBR)", with logos', () => {
    expect(lists.leagues[0]).toMatchObject({
      id: 13,
      label: 'Premier League (ENG 1)',
      img: `${ROOT}items/images/mobile/leagues/dark/13.png`,
    });
  });

  it('clubs per league, A-Z, with badges', () => {
    const prem = lists.clubs['13']!;
    expect(prem.length).toBeGreaterThanOrEqual(18);
    expect(prem.map((c) => c.label)).toContain('Arsenal');
    expect(prem.map((c) => c.label)).toEqual(
      [...prem.map((c) => c.label)].sort((a, b) => a.localeCompare(b)),
    );
    expect(prem.find((c) => c.label === 'Arsenal')!.img).toBe(
      `${ROOT}items/images/mobile/clubs/dark/1.png`,
    );
  });

  it('portraits', () => {
    expect(lists.portrait).toBe(`${ROOT}items/images/mobile/portraits/{id}.png`);
  });
});
