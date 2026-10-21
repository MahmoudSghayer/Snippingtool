import { describe, expect, it } from 'vitest';

import { ADAPTER_CHANNEL } from '../src/adapter-channel.js';
import {
  EMPTY_GALLERY,
  GALLERY_LIMITS,
  adapterActRequestMessageSchema,
  adapterActionResultMessageSchema,
  extBackgroundBotGallerySetPayloadSchema,
  extBackgroundFutggLineupPayloadSchema,
  futggLineupSchema,
  galleryStateSchema,
} from '../src/index.js';

const card = {
  key: '257289:85',
  name: 'Hugo Ekitiké',
  rating: 85,
  playerId: 257289,
  resourceId: 257289,
  rarity: 52,
  version: 'Signature',
  set: 'Ligue 1',
  status: 'listed',
  price: 3_700,
  market: 4_000,
  listPrice: 3_900,
  note: 'Not sent to your club: check the Set counted it',
} as const;

describe('galleryStateSchema', () => {
  it("takes Gallery mode's list with each card's progress", () => {
    expect(galleryStateSchema.parse({ budget: 100_000, spent: 3_700, cards: [card] })).toEqual({
      budget: 100_000,
      spent: 3_700,
      cards: [card],
    });
    expect(galleryStateSchema.parse(EMPTY_GALLERY)).toEqual({
      budget: 100_000,
      spent: 0,
      cards: [],
    });
    // `bot.gallerySet` validates the same shape.
    expect(extBackgroundBotGallerySetPayloadSchema.safeParse(EMPTY_GALLERY).success).toBe(true);
  });

  it('refuses unknown fields, unknown progress, and a list or budget past its limits', () => {
    const ok = { budget: 1_000, spent: 0, cards: [card] };
    expect(galleryStateSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      galleryStateSchema.safeParse({ ...ok, cards: [{ ...card, status: 'sold' }] }).success,
    ).toBe(false);
    expect(galleryStateSchema.safeParse({ ...ok, cards: [{ ...card, rating: 100 }] }).success).toBe(
      false,
    );
    expect(
      galleryStateSchema.safeParse({ ...ok, budget: GALLERY_LIMITS.budget.max + 1 }).success,
    ).toBe(false);
    expect(
      galleryStateSchema.safeParse({
        ...ok,
        cards: Array.from({ length: GALLERY_LIMITS.cards + 1 }, () => card),
      }).success,
    ).toBe(false);
  });
});

describe('fut.gg Sets on the list', () => {
  const exact = {
    key: '276695:80#67385559',
    name: 'Shea Charles',
    rating: 80,
    playerId: 276695,
    resourceId: 67385559,
    exact: true,
    rarity: 3,
    version: 'Team of the week Holographic',
    set: 'Fulham',
    setIds: [54],
    score: 338,
    guide: 19_500,
    status: 'owned',
  } as const;
  const set = {
    id: 54,
    name: 'Fulham',
    path: 'premier-league/fulham',
    grade: 'S',
    threshold: 5_900,
    score: 13_102,
    tokens: 38,
    cost: 65_100,
  } as const;

  it('takes an exact lineup card, owned already, and its Set', () => {
    const state = { budget: 100_000, spent: 0, cards: [exact], sets: [set] };
    expect(galleryStateSchema.parse(state)).toEqual(state);
  });

  it("takes a card's unfinished trade and the Sets marked completed", () => {
    const state = {
      budget: 100_000,
      spent: 1_300,
      cards: [{ ...exact, status: 'club', price: 1_300, tradeId: '512345678901' }],
      sets: [set],
      completed: [54, 90],
    };
    expect(galleryStateSchema.parse(state)).toEqual(state);
    expect(galleryStateSchema.safeParse({ ...state, completed: [0] }).success).toBe(false);
    expect(
      galleryStateSchema.safeParse({ ...state, cards: [{ ...exact, tradeId: '' }] }).success,
    ).toBe(false);
  });

  it('refuses a Set path that is not a fut.gg Set page, or an unknown grade', () => {
    const ok = { budget: 100_000, spent: 0, cards: [exact] };
    expect(
      galleryStateSchema.safeParse({ ...ok, sets: [{ ...set, path: '../admin' }] }).success,
    ).toBe(false);
    expect(galleryStateSchema.safeParse({ ...ok, sets: [{ ...set, grade: 'Z' }] }).success).toBe(
      false,
    );
    expect(
      galleryStateSchema.safeParse({ ...ok, cards: [{ ...exact, exact: false }] }).success,
    ).toBe(false);
  });

  it("checks fut.gg's lineup as background sends it", () => {
    const lineup = {
      set: {
        id: 90,
        name: 'Malaga CF',
        category: 'LALIGA EA SPORTS / Liga F Moeve',
        path: 'laliga/malaga-cf',
        requiredCards: 15,
        tiers: [
          {
            grade: 'S',
            threshold: 900,
            tokens: 28,
            cost: 20_850,
            peak: 3_100,
            score: 908,
            cards: 15,
          },
        ],
      },
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
        },
      ],
      missing: 0,
      others: [
        {
          resourceId: 74554,
          playerId: 74554,
          name: 'Einar Galilea',
          rating: 76,
          rarity: 0,
          version: 'Rare',
          holographic: false,
          score: 100,
          price: 0,
          nation: 45,
          club: 573,
          league: 54,
          positions: ['CB'],
          weakFoot: 3,
          skillMoves: 2,
        },
      ],
      tags: [
        {
          id: 8,
          name: 'Same Club',
          tiers: [{ minItems: 5, bonus: 1 }],
          rule: { type: 'MAX_COUNT_ALL_SAME', attribute: 'CLUB', values: ['0'] },
        },
      ],
    };
    expect(futggLineupSchema.parse(lineup)).toEqual(lineup);
    expect(futggLineupSchema.safeParse({ ...lineup, grade: 'SS' }).success).toBe(false);
    expect(extBackgroundFutggLineupPayloadSchema.safeParse({ setId: 90, grade: 'S' }).success).toBe(
      true,
    );
    expect(extBackgroundFutggLineupPayloadSchema.safeParse({ setId: 0, grade: 'S' }).success).toBe(
      false,
    );
  });

  it("carries the adapter's club read: card ids asked, and the ones the club holds", () => {
    const request = (resourceIds: unknown) =>
      adapterActRequestMessageSchema.safeParse({
        channel: ADAPTER_CHANNEL,
        kind: 'act_request',
        data: { action: 'owned', requestId: 'r1', resourceIds },
      }).success;
    expect(request([243312, 50574721])).toBe(true);
    expect(request([])).toBe(false);
    expect(request([0])).toBe(false);
    expect(request(Array.from({ length: 101 }, (_, i) => i + 1))).toBe(false);
    expect(
      adapterActionResultMessageSchema.safeParse({
        channel: ADAPTER_CHANNEL,
        kind: 'action_result',
        data: {
          action: 'owned',
          requestId: 'r1',
          ok: true,
          requestedAt: 1,
          completedAt: 2,
          owned: [243312],
        },
      }).success,
    ).toBe(true);
  });
});
