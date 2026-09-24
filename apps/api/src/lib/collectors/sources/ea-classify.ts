// Classifying an EA announcement, structurally.
//
// This is deliberately dumb, and that is the point. docs/14-ml-suggestions.md
// puts *interpretation* of news in Phase D, behind an LLM and a human review
// queue. Phase C only classifies what EA's own URL and title conventions make
// unambiguous, and files everything else under `content` — "EA announced
// something that puts items into the game" — rather than guessing at promo
// vs campaign vs SBC.
//
// The temptation here is a pile of keyword heuristics that look clever and
// are wrong a fifth of the time. A calendar that is confidently wrong is
// worse than one that is vague, because every later phase trains on it.
//
// Dates are the sharper version of the same rule. Checked against real
// articles: EA's promo posts do not state machine-readable start/end times.
// So nothing here invents a window — `announced_at` is the publication date,
// which is a fact, and starts/ends stay null until something actually knows.

export type MarketEventKind = 'content' | 'season' | 'pitch_notes' | 'ratings_refresh' | 'other';
export type NewsKind = 'news' | 'pitch_notes';

export interface ClassifiedArticle {
  newsKind: NewsKind;
  eventKind: MarketEventKind;
  /** False when the article is not a market event at all (a site/API notice,
   * a hardware promo) — it is still stored as a news item, because Phase D
   * may read it, but it does not go on the calendar. */
  isMarketEvent: boolean;
}

/** Slug prefix EA uses for Pitch Notes — the developer posts that carry
 * gameplay changes, i.e. the literal nerf/buff record (docs/14 §4b). */
const PITCH_NOTES_PREFIX = 'pitch-notes-';

/** `fc-26-season-10`, `fc-25-season-3`, … */
const SEASON_RE = /(?:^|-)season-\d+$/;

const RATINGS_RE = /(?:ratings-refresh|winter-upgrades|live-upgrades)/;

/**
 * Announcements that change nothing about item supply — an API programme
 * note, an edition/pre-order post, a hardware tie-in. They are news, not
 * market events, and putting them on a price calendar would add noise that
 * looks like signal.
 */
const NON_MARKET_SLUG_HINTS = [
  'community-api',
  'the-worlds-game-edition',
  'pre-order',
  'title-update-notes-pc',
  'anti-cheat',
];

export function classifyEaArticle(input: { slug: string; title?: string }): ClassifiedArticle {
  const slug = input.slug.toLowerCase();

  const isPitchNotes = slug.startsWith(PITCH_NOTES_PREFIX);
  const newsKind: NewsKind = isPitchNotes ? 'pitch_notes' : 'news';

  const nonMarket = NON_MARKET_SLUG_HINTS.some((hint) => slug.includes(hint));

  if (isPitchNotes) {
    // A Pitch Note is always worth having on the calendar even when it is
    // not a content drop: a gameplay change reprices every card carrying the
    // affected trait, which is exactly the cohort effect Phase E looks for.
    return { newsKind, eventKind: 'pitch_notes', isMarketEvent: !nonMarket };
  }

  if (RATINGS_RE.test(slug)) {
    return { newsKind, eventKind: 'ratings_refresh', isMarketEvent: true };
  }

  if (SEASON_RE.test(slug)) {
    return { newsKind, eventKind: 'season', isMarketEvent: true };
  }

  if (nonMarket) {
    return { newsKind, eventKind: 'other', isMarketEvent: false };
  }

  return { newsKind, eventKind: 'content', isMarketEvent: true };
}

/** `fc-26-futties` → `fc26`; used to keep an FC26 calendar from mixing with
 * an FC25 one, the same way card identity is scoped by title. */
export function fcTitleFromSlug(slug: string): string | null {
  const match = /(?:^|-)fc-?(\d{2})(?:-|$)/.exec(slug.toLowerCase());
  return match ? `fc${match[1]}` : null;
}
