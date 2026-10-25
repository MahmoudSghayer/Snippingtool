// Gallery mode's rules (`engine/gallery.ts`): the pasted list as cards, the
// prices a card is bought and listed at, and fut.gg's Sets on the list. The
// loop that works the list is in test/engine/sniper-gallery.test.ts.

import { GALLERY_LIMITS } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import {
  addFutggLineup,
  bestBuyableFutggTier,
  bestFutggTier,
  clearFinishedGallery,
  clubCheckIds,
  futggBestChoices,
  futggBuyableAlternative,
  futggClubIds,
  futggSetChoices,
  galleryCardNeeded,
  gallerySetBlockers,
  galleryUpgradable,
  galleryKey,
  galleryListPrices,
  galleryMarketCap,
  gallerySetProgress,
  gallerySnipeCap,
  gallerySummary,
  markCompletedSets,
  markOwned,
  nextGalleryCard,
  parseGalleryList,
  pickResourceId,
  planFutggSwaps,
  removeFutggSet,
  setCompleted,
} from '../../src/engine/gallery.js';

import type { CatalogOption, CatalogPlayer } from '../../src/model/catalog.js';
import type { FutggCard, FutggLineup, FutggSetSummary, FutggTag, GalleryCard, GalleryState } from '@sl/shared';

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
    expect(galleryListPrices(1_400)).toEqual({ buyNowPrice: 1_500, startPrice: 1_400, coversTax: false });
    expect(galleryListPrices(200)).toEqual({ buyNowPrice: 250, startPrice: 200, coversTax: false });
    expect(galleryListPrices(950)).toEqual({ buyNowPrice: 1_000, startPrice: 950, coversTax: false });
    // 2,000 brings back 1,900 after EA's 5% tax: no loss.
    expect(galleryListPrices(1_900)).toEqual({ buyNowPrice: 2_000, startPrice: 1_900, coversTax: false });
  });

  it("lists higher when EA's 5% tax on one step over would make it a loss: the lowest price that brings back what it cost", () => {
    // 3,000 would bring back 2,850; 3,100 brings back 2,945.
    expect(galleryListPrices(2_900)).toEqual({ buyNowPrice: 3_100, startPrice: 3_000, coversTax: true });
    expect(galleryListPrices(9_300)).toEqual({ buyNowPrice: 9_800, startPrice: 9_700, coversTax: true });
    // Across a change in EA's step (100 under 10,000, 250 from it).
    expect(galleryListPrices(9_900)).toEqual({ buyNowPrice: 10_500, startPrice: 10_250, coversTax: true });
    // Never past EA's highest price.
    expect(galleryListPrices(15_000_000).buyNowPrice).toBe(15_000_000);
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
    expect(gallerySummary(state)).toEqual({ todo: 2, bought: 0, club: 0, listed: 1, skipped: 1, owned: 0, sbc: 0, parked: 0, total: 4 });
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
  it("offers, for a grade, the Sets fut.gg has a lineup for, by fut.gg's categories, cheapest first", () => {
    const frosinone = { ...FROSINONE, category: 'Serie A Enilive' };
    const arsenal = { ...ARSENAL, category: 'Premier League / Barclays WSL' };
    const groups = (grade: 'S' | 'C' | 'A') =>
      futggSetChoices([MALAGA, arsenal, FOUNDATIONS, frosinone], grade).map((g) => [g.category, g.choices.map((c) => `${c.set.name} ${c.tier.cost}`)]);
    // Squad Foundations has nothing to buy at S.
    expect(groups('S')).toEqual([
      ['LALIGA EA SPORTS / Liga F Moeve', ['Malaga CF 20850']],
      ['Serie A Enilive', ['Frosinone 19600']],
    ]);
    expect(groups('C')).toEqual([
      ['LALIGA EA SPORTS / Liga F Moeve', ['Malaga CF 13250']],
      ['Premier League / Barclays WSL', ['Arsenal 63500']],
    ]);
    expect(groups('A')).toEqual([['LALIGA EA SPORTS / Liga F Moeve', ['Malaga CF 13450']]]);
  });
});

describe('fut.gg best-tier picker', () => {
  it('a Set\'s best grade is the highest it has a lineup to buy for', () => {
    expect(bestFutggTier(MALAGA)?.grade).toBe('S');
    expect(bestFutggTier(ARSENAL)?.grade).toBe('C'); // no S/B/A; D and C, best C
    expect(bestFutggTier(FROSINONE)?.grade).toBe('S');
    expect(bestFutggTier(FOUNDATIONS)).toBeNull(); // its only tier has nothing to buy
  });

  it('offers each Set once, at its best grade — not once per grade', () => {
    const frosinone = { ...FROSINONE, category: 'Serie A Enilive' };
    const arsenal = { ...ARSENAL, category: 'Premier League / Barclays WSL' };
    const groups = futggBestChoices([MALAGA, arsenal, FOUNDATIONS, frosinone]).map((g) => [
      g.category,
      g.choices.map((c) => `${c.set.name} ${c.tier.grade} ${c.tier.cost}`),
    ]);
    expect(groups).toEqual([
      ['LALIGA EA SPORTS / Liga F Moeve', ['Malaga CF S 20850']],
      ['Premier League / Barclays WSL', ['Arsenal C 63500']],
      ['Serie A Enilive', ['Frosinone S 19600']],
    ]);
  });
});

describe('fut.gg buyable-grade fallback', () => {
  // Best grade (S) needs one SBC/Objective card; A is entirely on the market.
  const SBC_S: FutggSetSummary = {
    ...MALAGA,
    id: 70,
    name: 'SBC at S',
    tiers: [tier('D', 13_250), tier('C', 13_250), tier('B', 13_250, { sbc: 2 }), tier('A', 13_450), tier('S', 20_850, { sbc: 1 })],
  };
  // Every grade needs a card off the market.
  const ALL_SBC: FutggSetSummary = { ...MALAGA, id: 71, name: 'SBC everywhere', tiers: [tier('A', 13_450, { sbc: 1 }), tier('S', 20_850, { sbc: 2 })] };

  it('bestBuyableFutggTier is the highest grade with no SBC/Objective card', () => {
    expect(bestBuyableFutggTier(SBC_S)?.grade).toBe('A'); // S needs SBC, B needs SBC; A is clean
    expect(bestBuyableFutggTier(MALAGA)?.grade).toBe('S'); // no SBC anywhere (field absent = 0)
    expect(bestBuyableFutggTier(ALL_SBC)).toBeNull(); // no grade is fully buyable
    expect(bestBuyableFutggTier(FOUNDATIONS)).toBeNull(); // nothing to buy at all
  });

  it('futggBuyableAlternative suggests a buyable grade only when the best grade needs SBC', () => {
    expect(futggBuyableAlternative(MALAGA)).toBeNull(); // best grade already buyable: nothing to suggest
    const sbc = futggBuyableAlternative(SBC_S);
    expect([sbc?.best.grade, sbc?.buyable?.grade, sbc?.best.sbc]).toEqual(['S', 'A', 1]);
    const none = futggBuyableAlternative(ALL_SBC);
    expect([none?.best.grade, none?.buyable]).toEqual(['S', null]); // best needs SBC, but no grade is buyable
  });
});

describe('galleryUpgradable', () => {
  const completedAt = (set: FutggSetSummary, grade: 'A' | 'S') => {
    const added = addFutggLineup(EMPTY, { set, grade, cards: [fcard()], missing: 0 }, []).state;
    return setCompleted(added, set.id, true, 1_000);
  };

  it('flags a completed Set fut.gg now grades higher than it was completed at', () => {
    const g = completedAt(MALAGA, 'A'); // completed at A; fut.gg's best is now S
    expect(g.completedGrade).toEqual({ '90': 'A' });
    expect(galleryUpgradable(g, [MALAGA, FROSINONE]).map((u) => [u.setId, u.from, u.to, u.tier.cost])).toEqual([[90, 'A', 'S', 20_850]]);
  });

  it('does not flag a Set already at its best grade, one with no kept grade, or one fut.gg no longer lists', () => {
    expect(galleryUpgradable(completedAt(MALAGA, 'S'), [MALAGA])).toEqual([]);
    expect(galleryUpgradable({ ...EMPTY, completed: [90] }, [MALAGA])).toEqual([]);
    expect(galleryUpgradable(completedAt(MALAGA, 'A'), [FROSINONE])).toEqual([]);
  });
});

describe('gallerySetBlockers', () => {
  const state = (): GalleryState =>
    addFutggLineup(
      EMPTY,
      lineup2(MALAGA, [
        fcard({ resourceId: 1, playerId: 1, name: 'Buy Me', price: 17_260 }),
        fcard({ resourceId: 2, playerId: 2, name: 'Clubbed' }),
        fcard({ resourceId: 3, playerId: 3, name: 'Gone SBC', price: 0 }),
        fcard({ resourceId: 4, playerId: 4, name: 'Not Listed' }),
      ]),
      [],
    ).state;

  it('groups a Set\'s still-missing cards by why each is not collected, collected ones aside', () => {
    const g = state();
    g.cards.find((c) => c.name === 'Clubbed')!.status = 'listed'; // collected — not a blocker
    g.cards.find((c) => c.name === 'Not Listed')!.status = 'skipped';
    const blockers = gallerySetBlockers(g, 90);
    expect(blockers.map((b) => [b.reason, b.cards.map((c) => c.name)])).toEqual([
      ['buy', ['Buy Me']],
      ['skipped', ['Not Listed']],
      ['sbc', ['Gone SBC']],
    ]);
    // The dear card carries fut.gg's price so the row can show why it lags.
    expect(blockers[0]!.cards[0]).toMatchObject({ name: 'Buy Me', rating: 74, guide: 17_260 });
    expect(blockers[2]!.cards[0]!.guide).toBeUndefined(); // an SBC card has no market price
  });

  it('is empty for a completed Set or one with every card collected', () => {
    expect(gallerySetBlockers(setCompleted(state(), 90, true), 90)).toEqual([]);
    const g = state();
    for (const c of g.cards) c.status = 'owned';
    expect(gallerySetBlockers(g, 90)).toEqual([]);
  });
});

describe('planFutggSwaps', () => {
  // One bonus tag: 10% of the gold cards' scores once two are gold.
  const GOLDEN: FutggTag = { id: 7, name: 'Golden', tiers: [{ minItems: 2, bonus: 10 }], rule: { type: 'COUNT', attribute: 'LEVEL', values: ['gold'] } };
  const a = fcard({ resourceId: 1, playerId: 1, name: 'Card A', rating: 80, score: 100, price: 3_000 });
  const b = fcard({ resourceId: 2, playerId: 2, name: 'Card B', rating: 76, score: 50, price: 1_000 });
  const c = fcard({ resourceId: 3, playerId: 3, name: 'Card C', rating: 70, score: 20, price: 500 });
  // Owned, not in the lineup: D (gold, scores more than A), E (silver,
  // scores more than B but loses the Golden bonus), F (scores too little).
  const d = fcard({ resourceId: 4, playerId: 4, name: 'Card D', rating: 82, score: 120, price: 0 });
  const e = fcard({ resourceId: 5, playerId: 5, name: 'Card E', rating: 70, score: 60, price: 0 });
  const f = fcard({ resourceId: 6, playerId: 6, name: 'Card F', rating: 66, score: 10, price: 0 });
  // 170 + 10% of A and B (150) = 185, as fut.gg says.
  const set: FutggSetSummary = { ...MALAGA, tiers: [tier('S', 4_500, { threshold: 205, score: 185, cards: 3 })] };
  const lineup: FutggLineup = { set, grade: 'S', cards: [a, b, c], missing: 0, others: [d, e, f], tags: [GOLDEN] };

  it('lets an owned player stand in, dearest card first, only while the Set keeps its grade, bonus tags included', () => {
    const plan = planFutggSwaps(lineup, new Set([4, 5, 6]));
    expect(plan.scored).toBe(true);
    // D for A: 190 + 10% of D and B (170) = 207. E for B would lose the
    // Golden bonus (200, under 205), so B stays; E for C keeps it: 230 + 17.
    // F scores under every card.
    expect(plan.swaps.map((x) => [x.out.name, x.in.name])).toEqual([
      ['Card A', 'Card D'],
      ['Card C', 'Card E'],
    ]);
    expect(plan.cards.map((x) => x.name)).toEqual(['Card D', 'Card B', 'Card E']);
    expect(plan.score).toBe(247);
  });

  it("swaps nothing when its score is not fut.gg's for fut.gg's lineup, or a tag's rule is unknown, or none is owned", () => {
    const off = planFutggSwaps({ ...lineup, set: { ...set, tiers: [tier('S', 4_500, { threshold: 205, score: 190, cards: 3 })] } }, new Set([4]));
    expect([off.scored, off.swaps.length]).toEqual([false, 0]);
    const unknown = planFutggSwaps({ ...lineup, tags: [{ ...GOLDEN, rule: { ...GOLDEN.rule, type: 'SOMETHING_NEW' } }] }, new Set([4]));
    expect([unknown.scored, unknown.swaps.length]).toEqual([false, 0]);
    expect(planFutggSwaps({ ...lineup, tags: undefined }, new Set([4])).swaps).toEqual([]);
    expect(planFutggSwaps(lineup, new Set()).cards).toEqual([a, b, c]);
  });

  it('puts the plan on the list: owned cards as in your club, the Set priced without the swapped cards', () => {
    const r = addFutggLineup(EMPTY, lineup, [], new Set([3, 4]));
    expect(r.state.cards.map((x) => [x.name, x.status])).toEqual([
      ['Card D', 'owned'],
      ['Card B', 'todo'],
      ['Card C', 'owned'],
    ]);
    expect([r.owned, r.swaps.length]).toEqual([2, 1]);
    expect(r.state.sets![0]).toMatchObject({ score: 207, cost: 1_500 });
  });

  it('asks the club about every lineup card first, then the Sets\' other cards', () => {
    expect(futggClubIds([lineup, { ...lineup, cards: [fcard({ resourceId: 9 })], others: [d] }])).toEqual([1, 2, 3, 9, 4, 5, 6]);
    expect(futggClubIds([lineup], 4)).toEqual([1, 2, 3, 4]);
  });
});

describe('completed Sets', () => {
  const state = (): GalleryState => {
    const g = addFutggLineup(EMPTY, lineup2(MALAGA, [fcard(), fcard({ resourceId: 5, playerId: 5, name: 'Shared' })]), []).state;
    return addFutggLineup(g, lineup2(FROSINONE, [fcard({ resourceId: 5, playerId: 5, name: 'Shared' }), fcard({ resourceId: 6, playerId: 6, name: 'Frosinone only' })]), []).state;
  };

  it('marks a Set completed once all its cards are collected', () => {
    const g = state();
    g.cards[0]!.status = 'listed';
    expect(markCompletedSets(g)).toEqual([]);
    g.cards[1]!.status = 'owned';
    expect(markCompletedSets(g, 1_000).map((x) => x.name)).toEqual(['Malaga CF']);
    expect(g.completed).toEqual([90]);
    expect(g.completedAt).toEqual({ '90': 1_000 });
    // Once only: its time stays the first one.
    expect(markCompletedSets(g, 2_000)).toEqual([]);
    expect(g.completedAt).toEqual({ '90': 1_000 });
  });

  it('records the grade each Set was completed at, by hand and automatically; Undo takes it away', () => {
    // state() adds Malaga (90) and Frosinone (91) at grade S.
    const byHand = setCompleted(state(), 90, true, 1_000);
    expect(byHand.completedGrade).toEqual({ '90': 'S' });
    expect(setCompleted(byHand, 90, false).completedGrade).toBeUndefined();

    const g = state();
    g.cards[0]!.status = 'listed';
    g.cards[1]!.status = 'owned';
    markCompletedSets(g, 1_000);
    expect(g.completedGrade).toEqual({ '90': 'S' });
  });

  it('keeps when each Set was completed: a Set marked by hand gets the time too, Undo takes it away', () => {
    const g = setCompleted(state(), 90, true, 1_000);
    expect(g.completedAt).toEqual({ '90': 1_000 });
    // Marked again: still the first time.
    expect(setCompleted(g, 90, true, 5_000).completedAt).toEqual({ '90': 1_000 });
    const both = setCompleted(g, 54, true, 2_000);
    expect(both.completed).toEqual([90, 54]);
    expect(both.completedAt).toEqual({ '90': 1_000, '54': 2_000 });
    const undone = setCompleted(both, 90, false);
    expect(undone.completed).toEqual([54]);
    expect(undone.completedAt).toEqual({ '54': 2_000 });
    const none = setCompleted(undone, 54, false);
    expect(none.completed).toBeUndefined();
    expect(none.completedAt).toBeUndefined();
  });

  it('a Set completed before times were kept has none, and gets none later', () => {
    const g: GalleryState = { ...state(), completed: [90] };
    const next = setCompleted(g, 54, true, 2_000);
    expect(next.completedAt).toEqual({ '54': 2_000 });
    expect(setCompleted(next, 54, false).completedAt).toBeUndefined();
  });

  it('holds no time for a Set that falls off the completed list', () => {
    const ids = Array.from({ length: GALLERY_LIMITS.completed }, (_, i) => i + 1_000);
    const g: GalleryState = { ...state(), completed: ids, completedAt: { [String(ids[0])]: 1, [String(ids[1])]: 2 } };
    const next = setCompleted(g, 90, true, 3_000);
    expect(next.completed).toHaveLength(GALLERY_LIMITS.completed);
    expect(next.completed).not.toContain(ids[0]);
    expect(next.completedAt).toEqual({ [String(ids[1])]: 2, '90': 3_000 });
  });

  it('clears what is finished on Reset stats: done cards and completed Sets go, the rest stays, spent goes to 0', () => {
    const g = state();
    // Malaga CF: both cards done (not yet marked); Frosinone: in progress.
    g.cards[0]!.status = 'listed';
    g.cards[1]!.status = 'owned';
    g.spent = 4_000;
    g.cards.push(
      // Left over from an earlier page load: bought, its Set removed since.
      { key: '7:72#7', name: 'Leftover', rating: 72, playerId: 7, resourceId: 7, exact: true, status: 'bought', price: 1_300 },
      // Bought on this page load, still on its way.
      { key: '8:70#8', name: 'On its way', rating: 70, playerId: 8, resourceId: 8, exact: true, status: 'club', price: 1_200, tradeId: 't8' },
      // A typed card, done.
      { key: '9:80', name: 'Typed', rating: 80, playerId: 9, resourceId: 9, status: 'listed' },
    );
    const next = clearFinishedGallery(g, 1_000);
    // 'Shared' stays: Frosinone, in progress, counts it too.
    expect(next.cards.map((c) => c.name)).toEqual(['Shared', 'Frosinone only', 'On its way']);
    expect(next.sets!.map((x) => x.name)).toEqual(['Frosinone']);
    expect(next.completed).toEqual([90]);
    expect(next.completedAt).toEqual({ '90': 1_000 });
    expect(next.spent).toBe(0);
    // Nothing left to clear: the list stays as it is.
    expect(clearFinishedGallery(next).cards).toEqual(next.cards);
  });

  it('leaves the cards of a Set marked completed alone, unless another Set needs them', () => {
    const g = setCompleted(state(), 90, true);
    expect(g.cards.map((x) => galleryCardNeeded(x, g))).toEqual([false, true, true]);
    expect(nextGalleryCard(g)?.name).toBe('Shared');
    expect(gallerySummary(g)).toMatchObject({ todo: 2, parked: 1 });
    expect(clubCheckIds(g)).toEqual([5, 6]);
    expect(setCompleted(g, 90, false).completed).toBeUndefined();
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

  it('marks a lineup card fut.gg has no market price for as sbc, so it is never bought or searched', () => {
    const sbcCard = fcard({ resourceId: 900, playerId: 900, name: 'SBC Only', price: 0 });
    const r = addFutggLineup(EMPTY, lineup(MALAGA, [fcard(), sbcCard]), []);
    expect(r.added).toBe(2);
    expect(r.sbc).toBe(1);
    const onList = r.state.cards.find((c) => c.playerId === 900)!;
    expect(onList.status).toBe('sbc');
    expect(onList.guide).toBeUndefined();
    expect(onList.note).toContain('SBC/Objective');
    // Only the tradeable card is ever a buy target; the sbc card is skipped.
    expect(nextGalleryCard(r.state)?.playerId).toBe(243312);
    expect(gallerySummary(r.state).sbc).toBe(1);
  });

  it('keeps an owned untradeable card as owned (the club copy counts), not sbc', () => {
    const r = addFutggLineup(EMPTY, lineup(MALAGA, [fcard({ resourceId: 900, playerId: 900, price: 0 })]), [], new Set([900]));
    expect(r.state.cards[0]!.status).toBe('owned');
    expect(r.sbc).toBe(0);
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

  it('counts a card collected only once it is through the club: bought does not count, club/listed/owned do', () => {
    const g = two();
    // card0 is shared by both Sets; card1 'Bought one' is Malaga's only.
    g.cards[0]!.status = 'club';
    g.cards[1]!.status = 'bought';
    expect(gallerySetProgress(g).map((p) => [p.set.name, p.done])).toEqual([
      ['Malaga CF', 1],
      ['Frosinone', 1],
    ]);
    // Listed by hand (or by Nova) and it counts; so does a Set complete now.
    g.cards[1]!.status = 'listed';
    expect(gallerySetProgress(g).find((p) => p.set.name === 'Malaga CF')!.done).toBe(2);
    expect(markCompletedSets(g).map((x) => x.name)).toEqual(['Malaga CF']);
  });

  it('keys an exact card by its id', () => {
    expect(galleryKey(276_695, 80, undefined, 67_385_559)).toBe('276695:80#67385559');
  });
});

function lineup2(set: FutggSetSummary, cards: FutggCard[]): FutggLineup {
  return { set, grade: 'S', cards, missing: 0 };
}
