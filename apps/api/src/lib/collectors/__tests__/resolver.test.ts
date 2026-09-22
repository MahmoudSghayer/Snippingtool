// The fuzzy half of entity resolution, tested with no database.
//
// docs/14-ml-suggestions.md §5: a series that silently mixes two versions of
// the same player is worse than no series, because it still looks plausible.
// These cases are the ones that would produce exactly that.

import { describe, expect, it } from 'vitest';

import {
  AMBIGUITY_MARGIN,
  MIN_CONFIDENCE,
  normaliseName,
  REVIEW_THRESHOLD,
  scoreCandidate,
} from '../resolver.js';

describe('normaliseName', () => {
  it('folds diacritics, case and punctuation so one player is one name', () => {
    expect(normaliseName('Mbappé')).toBe('mbappe');
    expect(normaliseName('MBAPPE')).toBe('mbappe');
    expect(normaliseName("O'Riley")).toBe('o riley');
    expect(normaliseName('  Van   Dijk ')).toBe('van dijk');
  });
});

describe('scoreCandidate', () => {
  it('scores an exact name match high enough to need no review', () => {
    const score = scoreCandidate({ name: 'Haaland' }, { name: 'Haaland' });
    expect(score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });

  it('matches on common name as well as full name', () => {
    const score = scoreCandidate(
      { name: 'Vini Jr' },
      { name: 'Vinicius Junior', commonName: 'Vini Jr' },
    );
    expect(score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });

  it('scores a mere substring well below an exact match', () => {
    // "Silva" is several real players; treating that as near-certain is how
    // the wrong card acquires a price series.
    const partial = scoreCandidate({ name: 'Silva' }, { name: 'Bernardo Silva' });
    const exact = scoreCandidate({ name: 'Bernardo Silva' }, { name: 'Bernardo Silva' });
    expect(partial).toBeLessThan(exact);
    expect(partial).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('returns zero when the name does not match at all', () => {
    expect(scoreCandidate({ name: 'Haaland' }, { name: 'Mbappe' })).toBe(0);
  });

  it('raises confidence when a stated rating agrees', () => {
    const withRating = scoreCandidate(
      { name: 'Haaland', rating: 91 },
      { name: 'Haaland', rating: 91 },
    );
    const without = scoreCandidate({ name: 'Haaland' }, { name: 'Haaland', rating: 91 });
    expect(withRating).toBeGreaterThan(without);
  });

  it('drops a disagreeing rating below the write threshold', () => {
    // "the 91 Haaland" must not resolve to the 88 card.
    const score = scoreCandidate({ name: 'Haaland', rating: 91 }, { name: 'Haaland', rating: 88 });
    expect(score).toBeLessThan(MIN_CONFIDENCE);
  });

  it('penalises a disagreeing card version', () => {
    const agree = scoreCandidate(
      { name: 'Haaland', cardVersion: 'TOTY' },
      { name: 'Haaland', cardVersion: 'TOTY' },
    );
    const disagree = scoreCandidate(
      { name: 'Haaland', cardVersion: 'TOTY' },
      { name: 'Haaland', cardVersion: 'Gold Rare' },
    );
    expect(disagree).toBeLessThan(agree);
    expect(disagree).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('treats a missing discriminator as neutral, not as disagreement', () => {
    // A source with no rating must not be punished for it, or every
    // sparse source would fail to resolve.
    const neutral = scoreCandidate(
      { name: 'Haaland', rating: 91 },
      { name: 'Haaland', rating: null },
    );
    expect(neutral).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
  });

  it('never returns a score outside 0..1', () => {
    const high = scoreCandidate(
      { name: 'Haaland', rating: 91, cardVersion: 'TOTY' },
      { name: 'Haaland', rating: 91, cardVersion: 'TOTY' },
    );
    const low = scoreCandidate(
      { name: 'Silva', rating: 99, cardVersion: 'TOTY' },
      { name: 'Bernardo Silva', rating: 10, cardVersion: 'Gold' },
    );
    expect(high).toBeLessThanOrEqual(1);
    expect(low).toBeGreaterThanOrEqual(0);
  });
});

describe('ambiguity policy', () => {
  it('two near-identical candidates are within the margin that refuses to guess', () => {
    // Both "Silva" cards score the same partial match; the runner-up margin
    // is what makes resolveCardRef return null instead of picking one.
    const a = scoreCandidate({ name: 'Silva' }, { name: 'Bernardo Silva' });
    const b = scoreCandidate({ name: 'Silva' }, { name: 'Thiago Silva' });
    expect(Math.abs(a - b)).toBeLessThan(AMBIGUITY_MARGIN);
  });

  it('a rating discriminator separates them enough to decide', () => {
    const a = scoreCandidate({ name: 'Silva', rating: 88 }, { name: 'Bernardo Silva', rating: 88 });
    const b = scoreCandidate({ name: 'Silva', rating: 88 }, { name: 'Thiago Silva', rating: 85 });
    expect(a - b).toBeGreaterThanOrEqual(AMBIGUITY_MARGIN);
  });
});
