// Gallery mode's rules (`engine/gallery.ts`): the pasted list as cards, and
// the prices a card is bought and listed at. The loop that works the list is
// in test/engine/sniper-gallery.test.ts.

import { describe, expect, it } from 'vitest';

import {
  galleryKey,
  galleryListPrices,
  galleryMarketCap,
  gallerySnipeCap,
  gallerySummary,
  nextGalleryCard,
  parseGalleryList,
  pickResourceId,
} from '../../src/engine/gallery.js';

import type { CatalogPlayer } from '../../src/model/catalog.js';
import type { GalleryCard } from '@sl/shared';

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

  it('then pays the market price, a step more after each search that found none, up to 10% over it', () => {
    expect(galleryMarketCap(4_000, 0)).toBe(4_000);
    expect(galleryMarketCap(4_000, 4)).toBe(4_400);
    expect(galleryMarketCap(4_000, 5)).toBeNull();
  });

  it('lists one step under the market price, with a starting bid a step under that', () => {
    expect(galleryListPrices(4_000)).toEqual({ buyNowPrice: 3_900, startPrice: 3_800 });
    // Never under EA's lowest prices.
    expect(galleryListPrices(200)).toEqual({ buyNowPrice: 200, startPrice: 150 });
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
    expect(gallerySummary(state)).toEqual({ todo: 2, bought: 0, club: 0, listed: 1, skipped: 1, total: 4 });
    expect(nextGalleryCard({ ...state, cards: [card('a', 'listed')] })).toBeNull();
  });
});
