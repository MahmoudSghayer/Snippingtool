// The calendar classifier, tested against real EA slugs.
//
// These are the actual slugs EA published for FC26, taken from the live news
// index while building this. The point of the test is less "does the regex
// work" and more "does it stay conservative": a calendar that confidently
// mislabels events is worse than one that says `content` a lot, because
// every later phase trains on it.

import { describe, expect, it } from 'vitest';

import { classifyEaArticle, fcTitleFromSlug } from '../sources/ea-classify.js';

describe('classifyEaArticle', () => {
  it('recognises Pitch Notes by slug prefix — the nerf/buff record', () => {
    const out = classifyEaArticle({ slug: 'pitch-notes-fc26-title-update-5' });
    expect(out.newsKind).toBe('pitch_notes');
    expect(out.eventKind).toBe('pitch_notes');
    expect(out.isMarketEvent).toBe(true);
  });

  it('recognises a season', () => {
    for (const slug of ['fc-26-season-10', 'fc-26-season-9']) {
      const out = classifyEaArticle({ slug });
      expect(out.eventKind).toBe('season');
      expect(out.isMarketEvent).toBe(true);
    }
  });

  it('files real promos under `content` rather than guessing a sub-type', () => {
    // Every one of these is a genuine FC26 promo. Distinguishing promo from
    // campaign from SBC event is Phase D's job, behind an LLM and a review
    // queue — not a keyword list here.
    for (const slug of [
      'fc-26-futties',
      'fc-26-summer-stars',
      'fc-26-phenoms',
      'fc-26-glory-hunters',
      'fc-26-greats-of-the-game',
      'fc-26-ultimate-rewind',
      'festival-of-football-path-to-glory',
    ]) {
      const out = classifyEaArticle({ slug });
      expect(out.eventKind).toBe('content');
      expect(out.isMarketEvent).toBe(true);
      expect(out.newsKind).toBe('news');
    }
  });

  it('keeps non-market announcements off the calendar', () => {
    // A programme note about an API moves no prices. Putting it on a price
    // calendar adds noise that looks like signal.
    const api = classifyEaArticle({ slug: 'pitch-notes-fc26-community-api-update' });
    expect(api.newsKind).toBe('pitch_notes'); // still stored as a news item
    expect(api.isMarketEvent).toBe(false); // but not an event

    const edition = classifyEaArticle({ slug: 'fc-26-the-worlds-game-edition' });
    expect(edition.isMarketEvent).toBe(false);
    expect(edition.eventKind).toBe('other');
  });

  it('recognises a ratings refresh, which reprices a whole cohort', () => {
    const out = classifyEaArticle({ slug: 'fc-26-winter-upgrades' });
    expect(out.eventKind).toBe('ratings_refresh');
    expect(out.isMarketEvent).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(classifyEaArticle({ slug: 'PITCH-NOTES-FC26-X' }).newsKind).toBe('pitch_notes');
  });

  it('does not mistake a word containing "season" for a season post', () => {
    // `season-10` is anchored at the end; "seasonal" is not a season.
    const out = classifyEaArticle({ slug: 'fc-26-seasonal-rewards-explained' });
    expect(out.eventKind).toBe('content');
  });
});

describe('fcTitleFromSlug', () => {
  it('scopes an event to its FC title, both slug spellings', () => {
    // EA uses both `fc-26-` and `fc26` in slugs; an FC26 calendar mixing with
    // an FC25 one is the same class of bug as a mixed price series.
    expect(fcTitleFromSlug('fc-26-futties')).toBe('fc26');
    expect(fcTitleFromSlug('pitch-notes-fc26-community-api-update')).toBe('fc26');
    expect(fcTitleFromSlug('fc-25-team-of-the-year')).toBe('fc25');
  });

  it('returns null when no title is encoded', () => {
    expect(fcTitleFromSlug('festival-of-football-path-to-glory')).toBeNull();
  });
});
