// background/futgg.ts: fut.gg's Gallery for Gallery mode. fut.gg documents
// no API, so this reads the JSON its Gallery pages load (the shapes below are
// trimmed from its real answers, Oct 2026); anything that does not read like
// that is left out, and the answers are reused for a few minutes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleFutggLineup, handleFutggSets, parseFutggHub, parseFutggPool, resetFutggCache } from '../../src/background/futgg.js';
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
          tier('A', 700, 13, 13_450, 1_300, 700, [{ eaId: 243312, price: 3_100 }]),
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
      { eaId: 243312, playerEaId: 243312, score: 60, overall: 74, rarityEaId: 0, rarityName: 'Rare', holographic: false, commonName: 'Dani Lorenzo', cardName: 'Lorenzo' },
      { eaId: 50_574_721, playerEaId: 243_073, score: 225, overall: 76, rarityEaId: 3, rarityName: 'Team of the week', holographic: true, commonName: '', cardName: 'Kevin' },
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
          { grade: 'A', threshold: 700, tokens: 13, cost: 13_450, peak: 1_300, score: 700, cards: 1 },
          { grade: 'S', threshold: 900, tokens: 28, cost: 20_850, peak: 3_100, score: 908, cards: 3 },
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

describe('handleFutggSets / handleFutggLineup', () => {
  it("asks this game's fut.gg Gallery once, and names the lineup's cards from the Set's card list", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
    const urls: string[] = [];
    serve(urls, { '/api/fut/gallery/fc27/hub/': HUB, '/api/fut/gallery/fc27/sets/90/pool/': POOL });
    expect((await handleFutggSets()).sets!.map((s) => s.name)).toEqual(['Malaga CF', 'Granada CF']);
    const { lineup } = await handleFutggLineup({ setId: 90, grade: 'S' });
    expect(lineup).toEqual({
      set: expect.objectContaining({ id: 90, name: 'Malaga CF' }),
      grade: 'S',
      cards: [
        { resourceId: 243312, playerId: 243312, name: 'Dani Lorenzo', rating: 74, rarity: 0, version: 'Rare', holographic: false, score: 60, price: 3_100 },
        // No common name: its card name.
        { resourceId: 50_574_721, playerId: 243_073, name: 'Kevin', rating: 76, rarity: 3, version: 'Team of the week', holographic: true, score: 225, price: 1_400 },
      ],
      // eaId 999 is not on the Set's card list.
      missing: 1,
    });
    // Reused: one hub and one pool request for all of it.
    await handleFutggLineup({ setId: 90, grade: 'A' });
    expect(urls).toEqual(['https://www.fut.gg/api/fut/gallery/fc27/hub/', 'https://www.fut.gg/api/fut/gallery/fc27/sets/90/pool/']);
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
