// engine/gallery-score.ts: a fut.gg Gallery Set's score as fut.gg's solver
// works it out. The fixture is fut.gg's own cheapest grade S lineup for
// Fulham and fut.gg's own bonus tags (Oct 2026), for which fut.gg says 5,721.

import { describe, expect, it } from 'vitest';

import { UnknownTagRule, galleryScore } from '../../src/engine/gallery-score.js';

import type { FutggCard, FutggTag } from '@sl/shared';

// fut.gg's cheapest grade S lineup for Fulham (Oct 21 2026), score 5721
const FULHAM: FutggCard[] = [
  { resourceId: 50402434, playerId: 70786, name: "Josh King", rating: 85, rarity: 71, version: "Future Stars", holographic: false, score: 3150, price: 52000, nation: 14, club: 144, league: 13, positions: ["CAM", "CDM", "CM"], weakFoot: 4, skillMoves: 3 },
  { resourceId: 213655, playerId: 213655, name: "Alex Iwobi", rating: 80, rarity: 0, version: "Rare", holographic: false, score: 180, price: 650, nation: 133, club: 144, league: 13, positions: ["CDM", "CM", "LM", "LW"], weakFoot: 3, skillMoves: 4 },
  { resourceId: 229348, playerId: 229348, name: "Antonee Robinson", rating: 80, rarity: 0, version: "Rare", holographic: false, score: 180, price: 800, nation: 95, club: 144, league: 13, positions: ["LB", "LM"], weakFoot: 3, skillMoves: 3 },
  { resourceId: 192563, playerId: 192563, name: "Bernd Leno", rating: 79, rarity: 0, version: "Rare", holographic: false, score: 160, price: 950, nation: 21, club: 144, league: 13, positions: ["GK"], weakFoot: 3, skillMoves: 1 },
  { resourceId: 224221, playerId: 224221, name: "Joachim Andersen", rating: 79, rarity: 0, version: "Rare", holographic: false, score: 160, price: 950, nation: 13, club: 144, league: 13, positions: ["CB"], weakFoot: 4, skillMoves: 2 },
  { resourceId: 228092, playerId: 228092, name: "Sander Berge", rating: 79, rarity: 0, version: "Rare", holographic: false, score: 160, price: 850, nation: 36, club: 144, league: 13, positions: ["CDM", "CM"], weakFoot: 3, skillMoves: 2 },
  { resourceId: 216266, playerId: 216266, name: "Kenny Tete", rating: 78, rarity: 0, version: "Rare", holographic: false, score: 140, price: 1000, nation: 34, club: 144, league: 13, positions: ["RB", "RM"], weakFoot: 2, skillMoves: 2 },
  { resourceId: 241436, playerId: 241436, name: "Calvin Bassey", rating: 78, rarity: 0, version: "Rare", holographic: false, score: 140, price: 1200, nation: 133, club: 144, league: 13, positions: ["CB"], weakFoot: 3, skillMoves: 2 },
  { resourceId: 240273, playerId: 240273, name: "Emile Smith Rowe", rating: 77, rarity: 0, version: "Rare", holographic: false, score: 120, price: 900, nation: 14, club: 144, league: 13, positions: ["CAM", "CM", "LM", "LW"], weakFoot: 4, skillMoves: 4 },
  { resourceId: 50600544, playerId: 268896, name: "Hugo Larsson", rating: 77, rarity: 0, version: "Rare", holographic: false, score: 120, price: 1300, nation: 46, club: 144, league: 13, positions: ["CDM", "CM"], weakFoot: 3, skillMoves: 3 },
  { resourceId: 70571, playerId: 70571, name: "Kevin", rating: 76, rarity: 0, version: "Rare", holographic: false, score: 100, price: 850, nation: 54, club: 144, league: 13, positions: ["LM", "LW"], weakFoot: 3, skillMoves: 4 },
  { resourceId: 277295, playerId: 277295, name: "Oscar Bobb", rating: 76, rarity: 0, version: "Rare", holographic: false, score: 100, price: 700, nation: 36, club: 144, league: 13, positions: ["LM", "LW", "RM", "RW"], weakFoot: 3, skillMoves: 4 },
  { resourceId: 70786, playerId: 70786, name: "Josh King", rating: 74, rarity: 0, version: "Rare", holographic: false, score: 35, price: 1700, nation: 14, club: 144, league: 13, positions: ["CAM", "CDM", "CM"], weakFoot: 4, skillMoves: 3 },
  { resourceId: 205990, playerId: 205990, name: "Harrison Reed", rating: 72, rarity: 0, version: "Rare", holographic: false, score: 35, price: 900, nation: 14, club: 144, league: 13, positions: ["CDM", "CM"], weakFoot: 3, skillMoves: 2 },
  { resourceId: 278578, playerId: 278578, name: "Jonah Kusi-Asare", rating: 62, rarity: 0, version: "Rare", holographic: false, score: 20, price: 350, nation: 46, club: 144, league: 13, positions: ["ST"], weakFoot: 3, skillMoves: 2 },
];
const TAGS: FutggTag[] = [
  { id: 3, name: "Same Nation", tiers: [{minItems: 5, bonus: 1}, {minItems: 10, bonus: 2}, {minItems: 20, bonus: 4}], rule: { type: 'MAX_COUNT_ALL_SAME', attribute: 'NATION', values: ["0"] } },
  { id: 17, name: "Different Nation", tiers: [{minItems: 5, bonus: 1}, {minItems: 10, bonus: 2}, {minItems: 20, bonus: 4}], rule: { type: 'COUNT_DIFF', attribute: 'NATION', values: ["0"] } },
  { id: 8, name: "Same Club", tiers: [{minItems: 5, bonus: 1}, {minItems: 10, bonus: 2}, {minItems: 20, bonus: 4}], rule: { type: 'MAX_COUNT_ALL_SAME', attribute: 'CLUB', values: ["0"] } },
  { id: 14, name: "Different Club", tiers: [{minItems: 5, bonus: 1}, {minItems: 10, bonus: 2}, {minItems: 20, bonus: 4}], rule: { type: 'COUNT_DIFF', attribute: 'CLUB', values: ["0"] } },
  { id: 16, name: "Same League", tiers: [{minItems: 5, bonus: 1}, {minItems: 10, bonus: 2}, {minItems: 20, bonus: 8}], rule: { type: 'MAX_COUNT_ALL_SAME', attribute: 'LEAGUEID', values: ["0"] } },
  { id: 6, name: "Different League", tiers: [{minItems: 5, bonus: 1}, {minItems: 10, bonus: 2}, {minItems: 20, bonus: 4}], rule: { type: 'COUNT_DIFF', attribute: 'LEAGUEID', values: ["0"] } },
  { id: 4, name: "Bronze", tiers: [{minItems: 5, bonus: 20}, {minItems: 10, bonus: 40}, {minItems: 20, bonus: 80}], rule: { type: 'COUNT', attribute: 'LEVEL', values: ["bronze"] } },
  { id: 11, name: "Silver", tiers: [{minItems: 5, bonus: 15}, {minItems: 10, bonus: 30}, {minItems: 20, bonus: 60}], rule: { type: 'COUNT', attribute: 'LEVEL', values: ["silver"] } },
  { id: 7, name: "Golden", tiers: [{minItems: 5, bonus: 1}, {minItems: 10, bonus: 2}, {minItems: 20, bonus: 4}], rule: { type: 'COUNT', attribute: 'LEVEL', values: ["gold"] } },
  { id: 12, name: "Holographic", tiers: [{minItems: 2, bonus: 8}, {minItems: 4, bonus: 12}, {minItems: 6, bonus: 20}], rule: { type: 'COUNT_ANY', attribute: 'HYPER_COSMETIC_TYPE', values: ["0", "1"] } },
  { id: 19, name: "Iconic", tiers: [{minItems: 2, bonus: 10}, {minItems: 4, bonus: 15}, {minItems: 6, bonus: 25}], rule: { type: 'COUNT', attribute: 'RARE', values: ["12"] } },
  { id: 2, name: "Heroic", tiers: [{minItems: 2, bonus: 8}, {minItems: 4, bonus: 12}, {minItems: 6, bonus: 20}], rule: { type: 'COUNT', attribute: 'RARE', values: ["72"] } },
  { id: 18, name: "TOTW", tiers: [{minItems: 3, bonus: 4}, {minItems: 6, bonus: 8}, {minItems: 10, bonus: 15}], rule: { type: 'COUNT', attribute: 'RARE', values: ["3"] } },
  { id: 1, name: "First Owner", tiers: [{minItems: 5, bonus: 150}, {minItems: 10, bonus: 300}, {minItems: 20, bonus: 500}], rule: { type: 'COUNT', attribute: 'FIRST_OWNED', values: ["1"] } },
  { id: 10, name: "Hands Only", tiers: [{minItems: 3, bonus: 3}, {minItems: 6, bonus: 6}, {minItems: 10, bonus: 15}], rule: { type: 'COUNT_ANY', attribute: 'POSSIBLE_POSITIONS', values: ["GK"] } },
  { id: 15, name: "Multiples!", tiers: [{minItems: 2, bonus: 10}, {minItems: 3, bonus: 15}, {minItems: 4, bonus: 20}], rule: { type: 'MAX_COUNT_ALL_SAME', attribute: 'BASE_DEF_ID', values: ["0"] } },
  { id: 20, name: "Ambidextrous", tiers: [{minItems: 3, bonus: 3}, {minItems: 5, bonus: 6}, {minItems: 10, bonus: 12}], rule: { type: 'MIN_COUNT', attribute: 'WEAK_FOOT', values: ["5"] } },
  { id: 5, name: "Skilled", tiers: [{minItems: 3, bonus: 3}, {minItems: 5, bonus: 6}, {minItems: 10, bonus: 12}], rule: { type: 'MIN_COUNT', attribute: 'SKILL_MOVES', values: ["4"] } },
  { id: 21, name: "Defensive Wall", tiers: [{minItems: 5, bonus: 3}, {minItems: 10, bonus: 6}, {minItems: 15, bonus: 10}], rule: { type: 'COUNT_ANY', attribute: 'POSSIBLE_POSITIONS', values: ["RB", "CB", "LB"] } },
  { id: 22, name: "Midfield Control", tiers: [{minItems: 5, bonus: 3}, {minItems: 10, bonus: 6}, {minItems: 15, bonus: 10}], rule: { type: 'COUNT_ANY', attribute: 'POSSIBLE_POSITIONS', values: ["CDM", "RM", "CM", "LM", "CAM"] } },
  { id: 23, name: "All out Attack", tiers: [{minItems: 5, bonus: 3}, {minItems: 10, bonus: 6}, {minItems: 15, bonus: 10}], rule: { type: 'COUNT_ANY', attribute: 'POSSIBLE_POSITIONS', values: ["ST", "LW", "RW"] } },
];

describe('galleryScore', () => {
  it("gives fut.gg's own score for fut.gg's Fulham lineup", () => {
    // 4,800 of the cards' own scores, plus Multiples! (Josh King twice: 10%
    // of 3,185), Midfield Control, Same Club, Same League, Golden, Different
    // Nation and All out Attack. Skilled does not count: EA counts skill
    // moves from 0, so its "4" is five stars.
    expect(galleryScore(FULHAM, TAGS)).toBe(5_721);
  });

  it('moves with the cards: a different player changes the tags he counts in', () => {
    // A five-star skiller in the last place: Skilled needs three.
    const swapped = FULHAM.map((c, i) => (i === FULHAM.length - 1 ? { ...c, skillMoves: 5 } : c));
    expect(galleryScore(swapped, TAGS)).toBe(5_721);
    // Without one Josh King, Multiples! is gone.
    expect(galleryScore(FULHAM.filter((c) => c.name !== 'Josh King' || c.rating !== 74), TAGS)).toBeLessThan(5_721 - 35);
  });

  it('refuses a rule or an attribute it does not know', () => {
    const tag = (type: string, attribute: string): FutggTag => ({ id: 1, name: 'New', tiers: [{ minItems: 1, bonus: 5 }], rule: { type, attribute, values: ['1'] } });
    expect(() => galleryScore(FULHAM, [tag('SOMETHING_NEW', 'NATION')])).toThrow(UnknownTagRule);
    expect(() => galleryScore(FULHAM, [tag('COUNT', 'HEIGHT')])).toThrow(UnknownTagRule);
  });
});
