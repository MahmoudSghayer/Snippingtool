// background/futgg.ts: fut.gg's Gallery for Gallery mode. fut.gg documents
// no API, so this reads the JSON its Gallery pages load (the shapes below are
// trimmed from its real answers, Oct 2026); anything that does not read like
// that is left out, and the answers are reused for a few minutes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleFutggLineup, handleFutggSets, parseFutggHub, parseFutggPool, parseFutggTags, resetFutggCache } from '../../src/background/futgg.js';
import { setFetchImpl } from '../../src/lib/http.js';

const tier = (grade: string, threshold: number, tokens: number, cost: number, peakPrice: number, totalScore: number, items: { eaId: number; price: number }[]) => ({
  grade,
  threshold,
  tokens,
  cost,
  peakPrice,
  totalScore,
  items,
});

const HUB = {
  data: {
    schemaVersion: 1,
    game: 'fc27',
    categories: [
      {
        id: 1,
        name: 'LALIGA EA SPORTS / Liga F Moeve',
        slug: 'laliga',
        priority: 3,
        sets: [
          { id: 90, categoryId: 1, name: 'Malaga CF', slug: 'malaga-cf', requiredCards: 15, grades: [], clubEaId: 573, totalTokens: 28 },
          // fut.gg has no lineup for this one.
          { id: 77, categoryId: 1, name: 'Granada CF', slug: 'granada-cf', requiredCards: 15, grades: [], clubEaId: 110832, totalTokens: 28 },
          // Unreadable: no slug.
          { id: 78, categoryId: 1, name: 'Broken' },
        ],
      },
    ],
    sets: [
      {
        setId: 90,
        grade: 'S',
        costTiers: [
          tier('S', 900, 28, 20_850, 3_100, 908, [
            { eaId: 243312, price: 3_100 },
            { eaId: 50_574_721, price: 1_400 },
            { eaId: 999, price: 900 },
          ]),
          // One card priced 0 by fut.gg: not on the market (SBC/Objective).
          tier('A', 700, 13, 13_450, 1_300, 700, [{ eaId: 243312, price: 3_100 }, { eaId: 888, price: 0 }]),
          // Not a grade.
          tier('Z', 1, 1, 1, 1, 1, []),
        ],
      },
      { setId: 77, grade: null, costTiers: [] },
    ],
  },
};

const POOL = {
  data: {
    setId: 90,
    items: [
      { eaId: 243312, playerEaId: 243312, score: 60, overall: 74, rarityEaId: 0, rarityName: 'Rare', holographic: false, commonName: 'Dani Lorenzo', cardName: 'Lorenzo', nationEaId: 45, clubEaId: 573, leagueEaId: 54, positions: ['CM'], weakFoot: 3, skillMoves: 2 },
      { eaId: 50_574_721, playerEaId: 243_073, score: 225, overall: 76, rarityEaId: 3, rarityName: 'Team of the week', holographic: true, commonName: '', cardName: 'Kevin' },
      // On the Set's card list, not in the lineup.
      { eaId: 74_554, playerEaId: 74_554, score: 100, overall: 76, rarityEaId: 0, rarityName: 'Rare', holographic: false, commonName: 'Einar Galilea', nationEaId: 45, clubEaId: 573, leagueEaId: 54, positions: ['CB'], weakFoot: 3, skillMoves: 2 },
    ],
  },
};

const SET_PAGE = {
  data: {
    tags: [
      { id: 8, name: 'Same Club', tiers: [{ minItems: 5, bonus: 1 }, { minItems: 10, bonus: 2 }], rules: [{ target: 'ATTRIBUTE', type: 'MAX_COUNT_ALL_SAME', attribute: 'CLUB', values: ['0'] }] },
      { id: 7, name: 'Golden', tiers: [{ minItems: 5, bonus: 1 }], rules: [{ target: 'ATTRIBUTE', type: 'COUNT', attribute: 'LEVEL', values: ['gold'] }] },
    ],
  },
};

beforeEach(() => resetFutggCache());
afterEach(() => {
  setFetchImpl((input, init) => fetch(input, init));
  vi.useRealTimers();
});

function serve(urls: string[], answers: Record<string, unknown>) {
  setFetchImpl(async (url) => {
    urls.push(url);
    const path = new URL(url).pathname;
    return path in answers ? new Response(JSON.stringify(answers[path]), { status: 200 }) : new Response('', { status: 404 });
  });
}

describe('parseFutggHub', () => {
  it("reads each Set with what each grade needs, gives and costs, D first, and the grade's lineup cards", () => {
    const hub = parseFutggHub(HUB)!;
    expect(hub.sets).toEqual([
      {
        id: 90,
        name: 'Malaga CF',
        category: 'LALIGA EA SPORTS / Liga F Moeve',
        path: 'laliga/malaga-cf',
        requiredCards: 15,
        tiers: [
          { grade: 'A', threshold: 700, tokens: 13, cost: 13_450, peak: 1_300, score: 700, cards: 2, sbc: 1 },
          { grade: 'S', threshold: 900, tokens: 28, cost: 20_850, peak: 3_100, score: 908, cards: 3, sbc: 0 },
        ],
      },
      { id: 77, name: 'Granada CF', category: 'LALIGA EA SPORTS / Liga F Moeve', path: 'laliga/granada-cf', requiredCards: 15, tiers: [] },
    ]);
    expect(hub.lineups.get(90)!.get('S')!.map((i) => i.resourceId)).toEqual([243312, 50_574_721, 999]);
  });

  it('is null for anything else', () => {
    expect(parseFutggHub('<html>Just a moment...</html>')).toBeNull();
    expect(parseFutggHub({ data: { categories: [] } })).toBeNull();
    expect(parseFutggHub(null)).toBeNull();
    expect(parseFutggPool({ data: { items: 'no' } })).toBeNull();
  });
});

describe('parseFutggTags', () => {
  it('reads each tag with its one rule, and nothing when a tag does not read', () => {
    expect(parseFutggTags(SET_PAGE)).toHaveLength(2);
    expect(parseFutggTags({ data: { tags: [{ id: 1, name: 'Two rules', tiers: [], rules: [{}, {}] }] } })).toBeNull();
    expect(parseFutggTags({ data: {} })).toBeNull();
  });
});

describe('handleFutggSets / handleFutggLineup', () => {
  it("asks this game's fut.gg Gallery once, and names the lineup's cards from the Set's card list", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
    const urls: string[] = [];
    serve(urls, { '/api/fut/gallery/fc27/hub/': HUB, '/api/fut/gallery/fc27/sets/90/pool/': POOL, '/api/fut/gallery/fc27/sets/laliga/malaga-cf/': SET_PAGE });
    expect((await handleFutggSets()).sets!.map((s) => s.name)).toEqual(['Malaga CF', 'Granada CF']);
    const { lineup } = await handleFutggLineup({ setId: 90, grade: 'S' });
    expect(lineup).toEqual({
      set: expect.objectContaining({ id: 90, name: 'Malaga CF' }),
      grade: 'S',
      cards: [
        {
          resourceId: 243312,
          playerId: 243312,
          name: 'Dani Lorenzo',
          rating: 74,
          rarity: 0,
          version: 'Rare',
          holographic: false,
          score: 60,
          price: 3_100,
          nation: 45,
          club: 573,
          league: 54,
          positions: ['CM'],
          weakFoot: 3,
          skillMoves: 2,
        },
        // No common name: its card name. Nothing known for its tags.
        { resourceId: 50_574_721, playerId: 243_073, name: 'Kevin', rating: 76, rarity: 3, version: 'Team of the week', holographic: true, score: 225, price: 1_400 },
      ],
      // eaId 999 is not on the Set's card list.
      missing: 1,
      // The Set's other cards, for owned ones to stand in.
      others: [expect.objectContaining({ resourceId: 74_554, name: 'Einar Galilea', price: 0, club: 573 })],
      tags: [
        { id: 8, name: 'Same Club', tiers: [{ minItems: 5, bonus: 1 }, { minItems: 10, bonus: 2 }], rule: { type: 'MAX_COUNT_ALL_SAME', attribute: 'CLUB', values: ['0'] } },
        { id: 7, name: 'Golden', tiers: [{ minItems: 5, bonus: 1 }], rule: { type: 'COUNT', attribute: 'LEVEL', values: ['gold'] } },
      ],
    });
    // Reused: one hub, one pool and one Set page request for all of it.
    await handleFutggLineup({ setId: 90, grade: 'A' });
    expect(urls).toEqual([
      'https://www.fut.gg/api/fut/gallery/fc27/hub/',
      'https://www.fut.gg/api/fut/gallery/fc27/sets/90/pool/',
      'https://www.fut.gg/api/fut/gallery/fc27/sets/laliga/malaga-cf/',
    ]);
  });

  it('is null when fut.gg fails, blocks, or has no lineup for the grade', async () => {
    const urls: string[] = [];
    serve(urls, { '/api/fut/gallery/fc27/hub/': HUB });
    expect(await handleFutggLineup({ setId: 77, grade: 'S' })).toEqual({ lineup: null });
    expect(await handleFutggLineup({ setId: 90, grade: 'B' })).toEqual({ lineup: null });
    // The pool answers 404.
    expect(await handleFutggLineup({ setId: 90, grade: 'S' })).toEqual({ lineup: null });
    resetFutggCache();
    setFetchImpl(async () => new Response('<html>blocked</html>', { status: 403 }));
    expect(await handleFutggSets()).toEqual({ sets: null });
  });
});
