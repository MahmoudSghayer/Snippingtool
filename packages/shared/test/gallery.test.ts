import { describe, expect, it } from 'vitest';

import {
  EMPTY_GALLERY,
  GALLERY_LIMITS,
  extBackgroundBotGallerySetPayloadSchema,
  galleryStateSchema,
} from '../src/index.js';

const card = {
  key: '257289:85',
  name: 'Hugo Ekitiké',
  rating: 85,
  playerId: 257289,
  resourceId: 257289,
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
