// Gallery mode's rules (`engine/gallery.ts`): the pasted list as cards, the
// prices a card is bought and listed at, and fut.gg's Sets on the list. The
// loop that works the list is in test/engine/sniper-gallery.test.ts.

import { describe, expect, it } from 'vitest';

import {
  addFutggLineup,
  clubCheckIds,
  futggBestTier,
  futggSetChoices,
  galleryKey,
  galleryListPrices,
  galleryMarketCap,
  gallerySetProgress,
  gallerySnipeCap,
  gallerySummary,
  markOwned,
  nextGalleryCard,
  parseGalleryList,
  pickResourceId,
  removeFutggSet,
} from '../../src/engine/gallery.js';

import type { CatalogOption, CatalogPlayer } from '../../src/model/catalog.js';
import type { FutggCard, FutggLineup, FutggSetSummary, GalleryCard, GalleryState } from '@sl/shared';

const PLAYERS: CatalogPlayer[] = [
  { id: 257289, name: 'Hugo Ekitiké', rating: 85 },
  { id: 256630, name: 'Florian Wirtz', rating: 86 },
  { id: 278046, name: 'Pau Cubarsí', rating: 86 },
  // Two players sharing a name: the one whose base card is under the rating wins.
  { id: 11, name: 'Rodri', rating: 90 },
  { id: 12, name: 'Rodri', rating: 75 },
  { id: 21, name: 'Lucas Silva', rating: 80 },
  { id: 22, name: 'Bernardo Silva', rating: 86 },
];

const RARITIES: CatalogOption[] = [
  { id: 0, value: '0', label: 'Common' },
  { id: 1, value: '1', label: 'Rare' },
  { id: 3, value: '3', label: 'Team of the Week' },
  { id: 52, value: '52', label: 'Signature' },
  { id: 53, value: '53', label: 'Signature Icon' },
];

describe('parseGalleryList', () => {
  it('reads one card a line, the rating on either side, under the Set heading above it', () => {
    const { cards, problems } = parseGalleryList(
      ['# Ligue 1 Set', 'Hugo Ekitiké 85', '86 florian wirtz', '', '// a note', 'Bundesliga:', 'Pau Cubarsi 88'].join('\n'),
      PLAYERS,
    );
    expect(problems).toEqual([]);
    expect(cards).toEqual([
      // A player's base card has the player's own id.
      { key: '257289:85', name: 'Hugo Ekitiké', rating: 85, playerId: 257289, resourceId: 257289, status: 'todo', set: 'Ligue 1 Set' },
      { key: '256630:86', name: 'Florian Wirtz', rating: 86, playerId: 256630, resourceId: 256630, status: 'todo', set: 'Ligue 1 Set' },
      // A special card's version is learned later, from a search.
      { key: '278046:88', name: 'Pau Cubarsí', rating: 88, playerId: 278046, status: 'todo', set: 'Bundesliga' },
    ]);
  });

  it('says why a line did not become a card, and loads the rest', () => {
    const { cards, problems } = parseGalleryList(
      ['Hugo Ekitiké', 'Nobody Known 80', 'Silva 82', 'Hugo Ekitiké 85', 'Hugo Ekitiké 85', 'Rodri 91'].join('\n'),
      PLAYERS,
    );
    expect(cards.map((c) => c.key)).toEqual([galleryKey(257289, 85), galleryKey(11, 91)]);
    expect(problems).toEqual([
      'Line 1: "Hugo Ekitiké" needs a player name and a rating (for example "Hugo Ekitiké 85")',
      'Line 2: no player named "Nobody Known" in EA\'s player list',
      'Line 3: "Silva" matches more than one player (Bernardo Silva, Lucas Silva…) — write the full name',
      'Line 5: Hugo Ekitiké 85 is on the list already',
    ]);
  });

  it('picks the namesake whose base card is the highest rated at or under the rating', () => {
    expect(parseGalleryList('Rodri 80', PLAYERS).cards[0]!.playerId).toBe(12);
    expect(parseGalleryList('Rodri 90', PLAYERS).cards[0]).toMatchObject({ playerId: 11, resourceId: 11 });
  });

  it("keeps a card's progress when the list is loaded again", () => {
    const done: GalleryCard = { key: '257289:85', name: 'Hugo Ekitiké', rating: 85, playerId: 257289, resourceId: 257289, status: 'listed', price: 3_500, listPrice: 3_600 };
    const { cards } = parseGalleryList('# New Set\nHugo Ekitiké 85\nFlorian Wirtz 86', PLAYERS, [done]);
    expect(cards[0]).toEqual({ ...done, set: 'New Set' });
    expect(cards[1]!.status).toBe('todo');
  });

  it('takes the version after the rating, from EA\'s Rarity list, so two versions of one rating are two cards', () => {
    const { cards, problems } = parseGalleryList(
      ['Hugo Ekitiké 85', 'Hugo Ekitiké 85 signature', 'Hugo Ekitiké 85 Team of the Week', 'Florian Wirtz 86 Rare'].join('\n'),
      PLAYERS,
      [],
      RARITIES,
    );
    expect(problems).toEqual([]);
    expect(cards.map((c) => [c.key, c.rarity, c.version, c.resourceId])).toEqual([
      // No version: any version at 85, the base card's id.
      ['257289:85', undefined, undefined, 257289],
      // A version asked for: its own id comes from the first search.
      ['257289:85:52', 52, 'Signature', undefined],
      ['257289:85:3', 3, 'Team of the Week', undefined],
      ['256630:86:1', 1, 'Rare', undefined],
    ]);
  });

  it('says when a version is not in EA\'s Rarity list, matches more than one, or the list is not loaded', () => {
    const lines = ['Hugo Ekitiké 85 Golden', 'Hugo Ekitiké 85 Sig', 'Hugo Ekitiké 85 Signature', 'Hugo Ekitiké 85 Signature'].join('\n');
    expect(parseGalleryList(lines, PLAYERS, [], RARITIES).problems).toEqual([
      'Line 1: no version named "Golden" in EA\'s Rarity list — use a name from the Rarity list on the Search tab',
      'Line 2: "Sig" matches more than one version (Signature, Signature Icon…) — write the full name',
      'Line 4: Hugo Ekitiké 85 Signature is on the list already',
    ]);
    expect(parseGalleryList('Hugo Ekitiké 85 Signature', PLAYERS).problems).toEqual([
      "Line 1: EA's Rarity list is not loaded yet — open the transfer market search once, then load the list again",
    ]);
  });

  it('needs EA\'s player list', () => {
    expect(parseGalleryList('Hugo Ekitiké 85', []).problems).toEqual([
      "Line 1: EA's player list is not loaded yet — open the transfer market search once, then load the list again",
    ]);
  });
});

describe('Gallery prices', () => {
  it('looks under the market price first: one EA price step under it', () => {
    expect(gallerySnipeCap(3_700)).toBe(3_600);
    expect(gallerySnipeCap(40_000)).toBe(39_750);
  });

  it('then the cheapest listed: from the market price, 1, 2, 4, 8… steps over it after each search that found none, with no limit', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => galleryMarketCap(4_000, n))).toEqual([4_000, 4_100, 4_200, 4_400, 4_800, 5_600]);
    // Never skipped: enough searches reach EA's highest price.
    expect(galleryMarketCap(4_000, 40)).toBe(15_000_000);
  });

  it('lists one step over what the card cost, with a starting bid a step under that', () => {
    expect(galleryListPrices(3_700)).toEqual({ buyNowPrice: 3_800, startPrice: 3_700 });
    expect(galleryListPrices(200)).toEqual({ buyNowPrice: 250, startPrice: 200 });
    expect(galleryListPrices(9_900)).toEqual({ buyNowPrice: 10_000, startPrice: 9_900 });
  });
});

describe('pickResourceId', () => {
  it("takes the player's base card when it is listed, else the version listed most", () => {
    expect(pickResourceId([{ resourceId: 50_100 }, { resourceId: 100 }], 100)).toBe(100);
    expect(pickResourceId([{ resourceId: 50_100 }, { resourceId: 60_100 }, { resourceId: 60_100 }], 100)).toBe(60_100);
    expect(pickResourceId([], 100)).toBeNull();
  });
});

describe('the list', () => {
  it('works through it in order and counts where each card is', () => {
    const card = (key: string, status: GalleryCard['status']): GalleryCard => ({ key, name: key, rating: 85, playerId: 1, status });
    const state = { budget: 10_000, spent: 0, cards: [card('a', 'listed'), card('b', 'skipped'), card('c', 'todo'), card('d', 'todo')] };
    expect(nextGalleryCard(state)?.key).toBe('c');
    expect(gallerySummary(state)).toEqual({ todo: 2, bought: 0, club: 0, listed: 1, skipped: 1, owned: 0, total: 4 });
    expect(nextGalleryCard({ ...state, cards: [card('a', 'listed')] })).toBeNull();
  });
});

// ---- fut.gg Sets -------------------------------------------------------------

const tier = (grade: 'D' | 'C' | 'B' | 'A' | 'S', cost: number, extra: Partial<FutggSetSummary['tiers'][number]> = {}) => ({
  grade,
  threshold: { D: 10, C: 300, B: 400, A: 700, S: 900 }[grade],
  tokens: { D: 0, C: 0, B: 5, A: 13, S: 28 }[grade],
  cost,
  peak: 1_000,
  score: 908,
  cards: 15,
  ...extra,
});

const MALAGA: FutggSetSummary = {
  id: 90,
  name: 'Malaga CF',
  category: 'LALIGA EA SPORTS / Liga F Moeve',
  path: 'laliga/malaga-cf',
  requiredCards: 15,
  tiers: [tier('D', 13_250), tier('C', 13_250), tier('B', 13_250), tier('A', 13_450), tier('S', 20_850)],
};
const FROSINONE: FutggSetSummary = { ...MALAGA, id: 91, name: 'Frosinone', path: 'serie-a/frosinone', tiers: [tier('S', 19_600)] };
const ARSENAL: FutggSetSummary = { ...MALAGA, id: 30, name: 'Arsenal', path: 'premier-league/arsenal', tiers: [tier('D', 500), tier('C', 63_500)] };
const FOUNDATIONS: FutggSetSummary = { ...MALAGA, id: 1, name: 'Squad Foundations', path: 'rarities/squad-foundations', tiers: [tier('S', 0, { cards: 0 })] };

const fcard = (extra: Partial<FutggCard> = {}): FutggCard => ({
  resourceId: 243312,
  playerId: 243312,
  name: 'Dani Lorenzo',
  rating: 74,
  rarity: 0,
  version: 'Rare',
  holographic: false,
  score: 60,
  price: 3_100,
  ...extra,
});

const lineup = (set: FutggSetSummary, cards: FutggCard[], missing = 0): FutggLineup => ({ set, grade: 'S', cards, missing });
const EMPTY: GalleryState = { budget: 100_000, spent: 0, cards: [] };

describe('fut.gg Set picker', () => {
  it("takes a Set's best grade, and offers only Sets with something to buy, cheapest first", () => {
    expect(futggBestTier(MALAGA)?.grade).toBe('S');
    expect(futggBestTier(FOUNDATIONS)).toBeNull();
    const names = (sOnly: boolean) => futggSetChoices([MALAGA, ARSENAL, FOUNDATIONS, FROSINONE], sOnly).map((c) => `${c.set.name} ${c.tier.grade}`);
    expect(names(true)).toEqual(['Frosinone S', 'Malaga CF S']);
    // Without the filter, the grade S Sets still come first.
    expect(names(false)).toEqual(['Frosinone S', 'Malaga CF S', 'Arsenal C']);
  });
});

describe('addFutggLineup', () => {
  const RARITIES: CatalogOption[] = [{ id: 3, value: '3', label: 'Team of the Week' }];

  it('puts each lineup card on the list by its exact id, under its Set', () => {
    const holo = fcard({ resourceId: 67_385_559, playerId: 276_695, name: 'Shea Charles', rating: 80, rarity: 3, version: 'Team of the week', holographic: true, score: 338, price: 19_500 });
    const odd = fcard({ resourceId: 50_400_000, playerId: 68_352, name: 'Someone', rating: 75, rarity: 999, version: 'Unknown', score: 40, price: 900 });
    // A newer gold card of the player, with its own id: fut.gg's rarity 0.
    const newer = fcard({ resourceId: 50_576_120, playerId: 244_472, name: 'Jens-Lys Cajuste', rating: 73, version: 'Rare', score: 35, price: 850 });
    const { state, added, already, problems } = addFutggLineup(EMPTY, lineup(MALAGA, [fcard(), holo, odd, newer]), [...RARITIES, { id: 0, value: '0', label: 'Common' }]);
    expect([added, already, problems]).toEqual([4, 0, []]);
    expect(state.cards).toEqual([
      // A base card: no rarity filter (fut.gg's 0 is not EA's Rare).
      { key: '243312:74#243312', name: 'Dani Lorenzo', rating: 74, playerId: 243312, resourceId: 243312, exact: true, status: 'todo', set: 'Malaga CF', setIds: [90], score: 60, guide: 3_100 },
      // A special card: its rarity searched for, holographic named.
      {
        key: '276695:80#67385559',
        name: 'Shea Charles',
        rating: 80,
        playerId: 276_695,
        resourceId: 67_385_559,
        exact: true,
        status: 'todo',
        set: 'Malaga CF',
        setIds: [90],
        score: 338,
        guide: 19_500,
        rarity: 3,
        version: 'Team of the week Holographic',
      },
      // A rarity EA's list does not have: found by its id alone.
      expect.objectContaining({ key: '68352:75#50400000', version: 'Unknown', exact: true }),
      // A gold card: no rarity filter or version, whatever its id.
      { key: '244472:73#50576120', name: 'Jens-Lys Cajuste', rating: 73, playerId: 244_472, resourceId: 50_576_120, exact: true, status: 'todo', set: 'Malaga CF', setIds: [90], score: 35, guide: 850 },
    ]);
    expect(state.cards[2]!.rarity).toBeUndefined();
    // A card fut.gg prices at 0 (none listed) carries no fut.gg price.
    expect(addFutggLineup(EMPTY, lineup(MALAGA, [fcard({ price: 0 })]), []).state.cards[0]!.guide).toBeUndefined();
    expect(state.sets).toEqual([{ id: 90, name: 'Malaga CF', path: 'laliga/malaga-cf', grade: 'S', threshold: 900, score: 908, tokens: 28, cost: 20_850 }]);
  });

  it('counts a card two Sets share once, for both, and keeps its progress when a Set is loaded again', () => {
    const first = addFutggLineup(EMPTY, lineup(MALAGA, [fcard()]), []).state;
    first.cards[0]!.status = 'listed';
    const both = addFutggLineup(first, lineup(FROSINONE, [fcard(), fcard({ resourceId: 1, playerId: 1, name: 'Other' })]), []);
    expect([both.added, both.already]).toEqual([1, 1]);
    expect(both.state.cards[0]).toMatchObject({ status: 'listed', setIds: [90, 91] });
    expect(both.state.sets!.map((x) => x.id)).toEqual([90, 91]);
    const again = addFutggLineup(both.state, lineup(MALAGA, [fcard()]), []);
    expect([again.added, again.already]).toEqual([0, 1]);
    expect(again.state.sets!.map((x) => x.id)).toEqual([91, 90]);
  });

  it("says when fut.gg does not describe some of the lineup's cards", () => {
    expect(addFutggLineup(EMPTY, lineup(MALAGA, [fcard()], 2), []).problems).toEqual([
      'Malaga CF: fut.gg does not describe 2 of its lineup cards, so they were left out and the Set may miss grade S',
    ]);
  });
});

describe('fut.gg Sets on the list', () => {
  const two = (): GalleryState => {
    const a = addFutggLineup(EMPTY, lineup(MALAGA, [fcard(), fcard({ resourceId: 5, playerId: 5, name: 'Bought one', score: 100 })]), []).state;
    return addFutggLineup(a, lineup(FROSINONE, [fcard(), fcard({ resourceId: 6, playerId: 6, name: 'Frosinone only' })]), []).state;
  };

  it('removes a Set: its own cards go, a shared one stays for the other Set, one on its way stays', () => {
    const g = two();
    g.cards[1]!.status = 'bought';
    const next = removeFutggSet(g, 90);
    expect(next.sets!.map((x) => x.id)).toEqual([91]);
    expect(next.cards.map((c) => [c.name, c.setIds])).toEqual([
      ['Dani Lorenzo', [91]],
      ['Bought one', undefined],
      ['Frosinone only', [91]],
    ]);
    expect(removeFutggSet(next, 91)).toEqual({ ...EMPTY, cards: [expect.objectContaining({ name: 'Bought one' })] });
  });

  it('asks the club about the cards still to buy, and marks the ones it holds (one way)', () => {
    const g = two();
    g.cards[2]!.status = 'listed';
    expect(clubCheckIds(g)).toEqual([243312, 5]);
    expect(clubCheckIds(g, 1)).toEqual([243312]);
    expect(markOwned(g, [5, 6])).toBe(1);
    expect(g.cards.map((c) => c.status)).toEqual(['todo', 'owned', 'listed']);
    // A typed card is never marked: its id may be any version.
    const typed: GalleryState = { ...EMPTY, cards: [{ key: '5:80', name: 'Typed', rating: 80, playerId: 5, resourceId: 5, status: 'todo' }] };
    expect(markOwned(typed, [5])).toBe(0);
  });

  it("says where each Set stands, and what its skipped cards' points are", () => {
    const g = two();
    g.cards[0]!.status = 'owned';
    g.cards[1]!.status = 'skipped';
    expect(gallerySetProgress(g).map((p) => [p.set.name, p.cards, p.done, p.skipped, p.skippedScore])).toEqual([
      ['Malaga CF', 2, 1, 1, 100],
      ['Frosinone', 2, 1, 0, 0],
    ]);
  });

  it('keys an exact card by its id', () => {
    expect(galleryKey(276_695, 80, undefined, 67_385_559)).toBe('276695:80#67385559');
  });
});
