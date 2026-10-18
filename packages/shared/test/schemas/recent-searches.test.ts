import { describe, expect, it } from 'vitest';

import {
  RECENT_SEARCHES_MAX,
  putRecentSearchesRequestSchema,
  recentSearchSchema,
  recentSearchesResponseSchema,
} from '../../src/schemas/recent-searches.js';

// The Nova AI page's stored `RecentSearch` (apps/extension ui/bot-page.ts),
// as `GET`/`PUT /extension/recent-searches` carry it.
const form = {
  minOvr: 45,
  maxOvr: 99,
  player: { id: 228702, name: 'Frenkie de Jong', rating: 86 },
  playerQuery: '',
  quality: null,
  rarity: null,
  position: null,
  chem: null,
  nation: null,
  league: null,
  club: null,
  minBuy: null,
  maxBuy: 52_000,
};
const entry = { at: 1_790_000_000_000, name: '86 Frenkie de Jong, max 52,000', form };

describe('recentSearchSchema', () => {
  it('accepts what the page stores, a typed player id and a filters-only search included', () => {
    expect(recentSearchSchema.parse(entry)).toEqual(entry);
    const typedId = { ...form, player: null, playerQuery: '20801' };
    expect(recentSearchSchema.safeParse({ ...entry, form: typedId }).success).toBe(true);
    const filters = {
      ...form,
      player: null,
      quality: 'SP',
      rarity: 3,
      position: '128',
      league: 13,
      club: 10,
    };
    expect(recentSearchSchema.safeParse({ ...entry, form: filters }).success).toBe(true);
  });

  it.each([
    ['an unknown key', { ...entry, extra: 1 }],
    ['an unknown form key', { ...entry, form: { ...form, extra: 1 } }],
    ['an unknown player key', { ...entry, form: { ...form, player: { ...form.player, x: 1 } } }],
    ['a missing form field', { ...entry, form: { ...form, club: undefined } }],
    ['an OVR off the slider', { ...entry, form: { ...form, maxOvr: 100 } }],
    ['a fractional OVR', { ...entry, form: { ...form, minOvr: 50.5 } }],
    ['a price past EA’s cap', { ...entry, form: { ...form, maxBuy: 15_000_001 } }],
    ['a negative id', { ...entry, form: { ...form, league: -1 } }],
    ['an empty name', { ...entry, name: '' }],
    ['a name over 200 characters', { ...entry, name: 'x'.repeat(201) }],
    ['a label over 100 characters', { ...entry, form: { ...form, playerQuery: 'x'.repeat(101) } }],
    ['a time that is not a whole number', { ...entry, at: 1.5 }],
  ])('rejects %s', (_label, value) => {
    expect(recentSearchSchema.safeParse(value).success).toBe(false);
  });
});

describe('putRecentSearchesRequestSchema / recentSearchesResponseSchema', () => {
  it(`takes up to ${RECENT_SEARCHES_MAX} entries, an empty list included`, () => {
    const full = Array.from({ length: RECENT_SEARCHES_MAX }, (_, i) => ({ ...entry, at: i + 1 }));
    expect(putRecentSearchesRequestSchema.safeParse({ items: full }).success).toBe(true);
    expect(putRecentSearchesRequestSchema.safeParse({ items: [] }).success).toBe(true);
    expect(
      putRecentSearchesRequestSchema.safeParse({ items: [...full, { ...entry, at: 99 }] }).success,
    ).toBe(false);
  });

  it('rejects an unknown top-level key (mass-assignment defence)', () => {
    expect(putRecentSearchesRequestSchema.safeParse({ items: [], userId: 'x' }).success).toBe(
      false,
    );
  });

  it('answers with a null updatedAt before the first save', () => {
    expect(recentSearchesResponseSchema.safeParse({ items: [], updatedAt: null }).success).toBe(
      true,
    );
  });
});
