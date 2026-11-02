// Gallery mode's pure calculations at full size (300 cards, 20 Sets; 250
// fut.gg Sets): what every redraw of the Set list and the feed costs.
import { afterAll, describe, expect, it } from 'vitest';

import {
  addFutggLineup,
  futggBestChoices,
  gallerySetBlockers,
  gallerySetProgress,
  gallerySummary,
  galleryUpgradable,
  markCompletedSets,
  nextGalleryCard,
} from '../../src/engine/gallery.js';

import { makeFutggSets, makeGallery, makeLineup } from './fixtures.js';
import { createSuite } from './harness.js';

const suite = createSuite('gallery');
afterAll(() => suite.flush());

describe('gallery calculations', () => {
  const g = makeGallery(300, 20);
  const sets = makeFutggSets(250);

  it('progress, blockers, summary and completion over 300 cards / 20 Sets', () => {
    suite.bench('gallerySetProgress (20 Sets)', () => ({ sets: gallerySetProgress(g).length }));
    suite.bench('gallerySetBlockers x20 Sets', () => {
      let n = 0;
      for (const s of g.sets ?? []) n += gallerySetBlockers(g, s.id).length;
      return { groups: n };
    });
    suite.bench('gallerySummary', () => ({ total: gallerySummary(g).total }));
    suite.bench('nextGalleryCard', () => ({ found: nextGalleryCard(g) ? 1 : 0 }));
    suite.bench('markCompletedSets', () => ({ done: markCompletedSets({ ...g, cards: g.cards.map((c) => ({ ...c })) }).length }));
    suite.bench('futggBestChoices (250 Sets)', () => ({ groups: futggBestChoices(sets).length }));
    suite.bench('galleryUpgradable (250 Sets)', () => ({ upgrades: galleryUpgradable(g, sets).length }));
    // The same redraw the page does: progress + blockers per Set + choices.
    suite.bench('one Set-list redraw worth of calculation', () => {
      const p = gallerySetProgress(g);
      let n = 0;
      for (const x of p) n += gallerySetBlockers(g, x.set.id).length;
      n += futggBestChoices(sets).length + galleryUpgradable(g, sets).length;
      return { n };
    });
  });

  it('adding 20 fut.gg lineups to an empty list', () => {
    const r = suite.bench('addFutggLineup x20 (15 cards each)', () => {
      let state = { budget: 1_000_000, spent: 0, cards: [] } as ReturnType<typeof makeGallery>;
      let added = 0;
      for (let i = 0; i < 20; i++) {
        const out = addFutggLineup(state, makeLineup(sets[i]!, 'S', i), [], new Set());
        state = out.state;
        added += out.added;
      }
      return { added, cards: state.cards.length };
    }, { runs: 3 });
    expect(r.meta?.added).toBe(300);
  });
});
