// The bot's copy of the Gallery list (`engine/sniper.ts` setGallery /
// getGallery): every field the list carries survives the round trip — the
// grade each Set was completed at used to be dropped, which hid the Upgrade
// control and erased it from the account on the next save — and the version
// goes up on every change, so the page keeps its copy between changes.

import { DEFAULT_BOT_SETTINGS, type GalleryState } from '@sl/shared';
import { describe, expect, it, vi } from 'vitest';

import { Sniper } from '../../src/engine/sniper.js';

function makeSniper(): Sniper {
  return new Sniper(
    {
      adapter: {
        search: vi.fn(),
        buy: vi.fn(),
        list: vi.fn(),
        onAuctions: () => () => undefined,
        onBuyable: () => () => undefined,
        onProbe: () => () => undefined,
        onShape: () => () => undefined,
      } as never,
      getFilters: () => [],
      estimateSellPrice: async () => null,
      killSwitch: () => ({ active: false }),
      onChange: () => undefined,
    },
    DEFAULT_BOT_SETTINGS,
  );
}

const STATE: GalleryState = {
  budget: 50_000,
  spent: 1_200,
  cards: [{ key: '1:85:x', name: 'Hugo Ekitiké', rating: 85, playerId: 1, resourceId: 50_000_001, exact: true, setIds: [90], score: 60, status: 'owned' }],
  sets: [{ id: 90, name: 'Malaga CF', path: 'laliga/malaga-cf', grade: 'S', threshold: 900, score: 908, tokens: 28, cost: 20_850, tiers: [{ grade: 'A', threshold: 700 }, { grade: 'S', threshold: 900 }], spares: [{ resourceId: 7, playerId: 7, name: 'Spare', rating: 70, score: 40 }], upgrade: { grade: 'S', tokens: 28, cards: ['Kevin'] } }],
  completed: [90],
  completedAt: { '90': 1_760_000_000_000 },
  completedGrade: { '90': 'A' },
};

describe('Sniper.getGallery', () => {
  it('is a copy of everything the list holds, completedGrade included', () => {
    const sniper = makeSniper();
    sniper.setGallery(STATE);
    const got = sniper.getGallery();
    expect(got).toEqual(STATE);
    expect(got).not.toBe(STATE);
    expect(got.cards[0]).not.toBe(STATE.cards[0]);
    expect(got.sets![0]).not.toBe(STATE.sets![0]);
    expect(got.completedGrade).not.toBe(STATE.completedGrade);
  });

  it('has a version that goes up when the list is set, and not when it is read', () => {
    const sniper = makeSniper();
    const v0 = sniper.getGalleryVersion();
    sniper.getGallery();
    expect(sniper.getGalleryVersion()).toBe(v0);
    sniper.setGallery(STATE);
    expect(sniper.getGalleryVersion()).toBe(v0 + 1);
  });
});
