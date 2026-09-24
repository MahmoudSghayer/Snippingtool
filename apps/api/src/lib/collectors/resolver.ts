// Entity resolution: a source's idea of a card → our canonical `cards` row.
//
// docs/14-ml-suggestions.md §5 calls this the unglamorous blocker, and the
// reason is worth restating where the code lives: a price series that
// silently mixes two card versions of the same player is *worse* than no
// series, because it still looks plausible. Everything downstream inherits
// whatever this module gets wrong, and it gets it wrong quietly.
//
// So the design is deliberately conservative:
//
//   - An alias already in `card_source_ids` wins outright. Resolution is
//     sticky: once a mapping is established (or reviewed by a human) it is
//     not silently re-derived on the next run.
//   - An explicit `resourceId` is an exact match — EA's own identifier, no
//     guessing involved.
//   - A name match is a *guess*. It is stored with its confidence and, below
//     the review threshold, is written but left unreviewed so it surfaces in
//     the review queue rather than being trusted.
//   - Ambiguity loses. Two candidates scoring within a hair of each other
//     resolve to nothing at all, because picking one at random is how a
//     series gets silently poisoned.

import { cards, cardSourceIds } from '@sl/db';
import { and, eq, ilike, or } from 'drizzle-orm';

import type { CardRef, CollectorContext, MarketSource } from './types.js';

/** Below this, a mapping is recorded but left `reviewed_at IS NULL` so it
 * appears in the human review queue (`card_source_ids_review_idx`). */
export const REVIEW_THRESHOLD = 0.9;

/** A second candidate this close to the best one means we cannot tell them
 * apart, and resolution fails rather than guessing. */
export const AMBIGUITY_MARGIN = 0.05;

/** Below this nothing is written at all — a match this weak is noise. */
export const MIN_CONFIDENCE = 0.6;

export interface ResolvedCard {
  cardId: string;
  confidence: number;
  resolvedBy: 'alias' | 'resource_id' | 'name';
}

/** The FC title new cards are filed under. Part of card identity because EA
 * reuses resource ids across titles — without it, FC26 prices would append
 * silently to an FC25 series. */
export const CURRENT_FC_TITLE = process.env.FC_TITLE ?? 'fc26';

/**
 * Resolve (and if necessary create) the canonical card for a source's
 * reference to one. Returns null when the reference is too weak or too
 * ambiguous to act on — callers count that as a parse failure rather than
 * inventing an identity.
 */
export async function resolveCardRef(
  ctx: CollectorContext,
  source: MarketSource,
  ref: CardRef,
): Promise<ResolvedCard | null> {
  const { db } = ctx;

  // 1. Established alias. Sticky by design.
  if (ref.externalId) {
    const existing = await db
      .select({ cardId: cardSourceIds.cardId })
      .from(cardSourceIds)
      .where(and(eq(cardSourceIds.source, source), eq(cardSourceIds.externalId, ref.externalId)))
      .limit(1);
    if (existing[0]) {
      return { cardId: existing[0].cardId, confidence: 1, resolvedBy: 'alias' };
    }
  }

  // 2. EA resource id — an exact identity, not a guess. Creates the canonical
  //    row when this is the first time we have seen the card.
  if (ref.resourceId) {
    const cardId = await upsertCardByResourceId(ctx, ref);
    if (ref.externalId) {
      await recordAlias(ctx, source, cardId, ref.externalId, ref.url, 1, 'resource_id', true);
    }
    return { cardId, confidence: 1, resolvedBy: 'resource_id' };
  }

  // 3. Name. A guess, scored and possibly refused.
  if (ref.name) {
    const match = await matchByName(ctx, ref);
    if (!match) return null;
    if (ref.externalId) {
      await recordAlias(
        ctx,
        source,
        match.cardId,
        ref.externalId,
        ref.url,
        match.confidence,
        'name',
        match.confidence >= REVIEW_THRESHOLD,
      );
    }
    return { cardId: match.cardId, confidence: match.confidence, resolvedBy: 'name' };
  }

  return null;
}

async function upsertCardByResourceId(ctx: CollectorContext, ref: CardRef): Promise<string> {
  const { db } = ctx;
  const resourceId = ref.resourceId!;

  const existing = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.resourceId, resourceId), eq(cards.fcTitle, CURRENT_FC_TITLE)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [created] = await db
    .insert(cards)
    .values({
      resourceId,
      fcTitle: CURRENT_FC_TITLE,
      name: ref.name ?? `card ${resourceId}`,
      rating: ref.rating,
      cardVersion: ref.cardVersion,
    })
    .onConflictDoNothing()
    .returning({ id: cards.id });

  if (created) return created.id;

  // Lost an insert race against a concurrent collector — re-read rather than
  // failing, since the other writer produced exactly the row we wanted.
  const raced = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.resourceId, resourceId), eq(cards.fcTitle, CURRENT_FC_TITLE)))
    .limit(1);
  return raced[0]!.id;
}

interface NameMatch {
  cardId: string;
  confidence: number;
}

/**
 * Name matching, narrowed by whatever else the reference carries.
 *
 * Rating and card version are treated as *discriminators, not filters*: news
 * text says "the 91 Haaland", and using that to pick between candidates is
 * exactly right, while using it to exclude candidates would drop the card
 * whenever a source's rating is stale or missing.
 */
async function matchByName(ctx: CollectorContext, ref: CardRef): Promise<NameMatch | null> {
  const { db } = ctx;
  const needle = normaliseName(ref.name!);
  if (needle.length < 3) return null;

  // Candidate set from a case-insensitive containment match; scoring happens
  // in JS below, where the fuzzy logic is testable without a database.
  //
  // A leading-wildcard ILIKE cannot use `cards_name_idx` (a btree on
  // lower(name) only serves anchored prefixes), so this is a sequential scan.
  // That is a deliberate Phase A choice rather than an oversight: a title's
  // card list is tens of thousands of rows, which scans in single-digit
  // milliseconds, and the alternative — a pg_trgm GIN index — means adding a
  // Postgres extension to the deployment for a query that is not yet hot.
  // Revisit if resolution ever runs per-price rather than per-new-card.
  const pattern = `%${needle}%`;
  const candidates = await db
    .select({
      id: cards.id,
      name: cards.name,
      commonName: cards.commonName,
      rating: cards.rating,
      cardVersion: cards.cardVersion,
    })
    .from(cards)
    .where(
      and(
        eq(cards.fcTitle, CURRENT_FC_TITLE),
        or(ilike(cards.name, pattern), ilike(cards.commonName, pattern)),
      ),
    )
    .limit(50);

  if (candidates.length === 0) return null;

  const scored = candidates
    .map((c) => ({ cardId: c.id, confidence: scoreCandidate(ref, c) }))
    .filter((c) => c.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);

  if (scored.length === 0) return null;

  const best = scored[0]!;
  const runnerUp = scored[1];
  // Cannot tell them apart → resolve to nothing. Guessing here is how a
  // series gets silently poisoned.
  if (runnerUp && best.confidence - runnerUp.confidence < AMBIGUITY_MARGIN) return null;

  return best;
}

export interface ScorableCard {
  name: string;
  commonName?: string | null;
  rating?: number | null;
  cardVersion?: string | null;
}

/** Exported for tests: the whole fuzzy decision, with no database in it. */
export function scoreCandidate(ref: CardRef, card: ScorableCard): number {
  const needle = normaliseName(ref.name ?? '');
  const name = normaliseName(card.name);
  const common = card.commonName ? normaliseName(card.commonName) : '';

  let score: number;
  if (needle === name || (common && needle === common)) {
    score = 0.9;
  } else if (name.includes(needle) || (common && common.includes(needle))) {
    // A substring of a longer name is much weaker: "silva" matches several
    // real players, and treating that as near-certain is how the wrong card
    // gets a price series.
    score = 0.7;
  } else {
    return 0;
  }

  // Discriminators. Present-and-agreeing raises confidence; present-and-
  // disagreeing is strong evidence of the wrong card.
  if (ref.rating !== undefined && card.rating != null) {
    score += ref.rating === card.rating ? 0.08 : -0.4;
  }
  if (ref.cardVersion && card.cardVersion) {
    score += normaliseName(ref.cardVersion) === normaliseName(card.cardVersion) ? 0.05 : -0.2;
  }

  return Math.max(0, Math.min(1, score));
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace — so
 * "Mbappé", "MBAPPE" and "Mbappe" are one name. */
export function normaliseName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function recordAlias(
  ctx: CollectorContext,
  source: MarketSource,
  cardId: string,
  externalId: string,
  url: string | undefined,
  confidence: number,
  resolvedBy: string,
  reviewed: boolean,
): Promise<void> {
  await ctx.db
    .insert(cardSourceIds)
    .values({
      cardId,
      source,
      externalId,
      url,
      confidence: confidence.toFixed(3),
      resolvedBy,
      reviewedAt: reviewed ? new Date() : null,
    })
    .onConflictDoNothing();
}
