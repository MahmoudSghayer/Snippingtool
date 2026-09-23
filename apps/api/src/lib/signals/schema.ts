// The shape a signal is allowed to take.
//
// docs/14-ml-suggestions.md §8 #4: "Output is strictly structured —
// direction, magnitude bucket, target card or cohort, confidence — never
// free prose presented as a prediction."
//
// This file is where that rule is actually enforced. There is deliberately no
// field an extractor can write a forecast into: prose reads as authoritative,
// cannot be measured, and would end up in front of users the moment somebody
// decided the review queue was slowing things down. `rationale` and
// `evidence` exist so a *reviewer* can judge the extraction against the
// article — they are not user-facing copy.
//
// The same schema is handed to the model as its output contract and used to
// validate what comes back, so the two cannot drift apart.

import { z } from 'zod';

/** Bump when the prompt or this schema changes in a way that could alter
 * output. Precision is only meaningful per model + prompt, so every stored
 * signal records which pair produced it. */
export const PROMPT_VERSION = 'v2';

export const signalDirectionSchema = z.enum(['up', 'down', 'unclear']);

/**
 * Buckets, not percentages. EA writes "buffed" and "nerfed"; it does not write
 * "-14%". Asking the model for a number would manufacture precision that
 * later evaluation would then dutifully score against.
 */
export const signalMagnitudeSchema = z.enum(['small', 'moderate', 'large', 'unclear']);

/**
 * A cohort predicate — the target form that matters most here.
 *
 * A Pitch Notes playstyle nerf reprices *every* card carrying that playstyle.
 * Modelling targets as card-only would force the extractor to either invent a
 * card list it has no way to know, or discard the highest-value signal in the
 * corpus. Fields are all optional and combine as AND.
 */
export const cohortPredicateSchema = z
  .object({
    /** An unresolved player name — honestly "whatever cards this name refers
     * to". Present because resolution legitimately fails (a name the card
     * table has never seen), and the alternative tried first was worse: the
     * name was stuffed into `club`, so a cohort query for a club returned
     * Thierry Henry. A wrong field is not a smaller bug than a missing one. */
    playerName: z.string().min(1).max(120).optional(),
    playstyle: z.string().min(1).max(60).optional(),
    position: z.string().min(1).max(10).optional(),
    league: z.string().min(1).max(80).optional(),
    nation: z.string().min(1).max(80).optional(),
    club: z.string().min(1).max(80).optional(),
    cardVersion: z.string().min(1).max(60).optional(),
    ratingMin: z.number().int().min(0).max(99).optional(),
    ratingMax: z.number().int().min(0).max(99).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'a cohort must constrain at least one attribute',
  })
  // Rejecting `{}` is not enough: a real extraction returned
  // `{ratingMin: 0, ratingMax: 99}`, which is the whole game wearing the
  // shape of a constraint. A cohort that excludes nothing is a signal about
  // everything, which is a signal about nothing — and unlike `{}` it looks
  // specific enough to pass review.
  .refine((v) => !isVacuous(v), {
    message: 'a cohort must actually exclude something',
  });

/** Words that name no subset — a real extraction produced
 * `{cardVersion: "Any"}`, which constrains exactly nothing. */
const VACUOUS_VALUES = new Set(['any', 'all', 'every', 'various', 'multiple', 'n/a', 'none']);

/** True when a predicate matches every card despite having fields set. */
function isVacuous(v: Record<string, unknown>): boolean {
  const named = Object.entries(v).filter(
    ([k, value]) =>
      k !== 'ratingMin' &&
      k !== 'ratingMax' &&
      !(typeof value === 'string' && VACUOUS_VALUES.has(value.trim().toLowerCase())),
  );
  if (named.length > 0) return false; // some real attribute is constrained

  // Rating-only cohort: vacuous when the span covers the whole scale.
  const min = typeof v.ratingMin === 'number' ? v.ratingMin : 0;
  const max = typeof v.ratingMax === 'number' ? v.ratingMax : 99;
  return min <= 0 && max >= 99;
}

export const extractedSignalSchema = z
  .object({
    direction: signalDirectionSchema,
    magnitude: signalMagnitudeSchema,
    /** The model's own confidence that this signal is really in the text. */
    confidence: z.number().min(0).max(1),

    /** A named player, when the article names one. Resolved to a card id
     * later — the extractor works in the article's vocabulary and never
     * invents an identity (see lib/collectors/resolver.ts for why). */
    playerName: z.string().min(1).max(120).nullable(),
    /** A cohort, when the change is trait-wide rather than player-specific. */
    cohort: cohortPredicateSchema.nullable(),

    /** The phrase from the article this was read off, verbatim. Makes a
     * review a spot-check rather than a re-read. */
    evidence: z.string().min(1).max(500),
    /** Why the extractor read it that way. For reviewers only. */
    rationale: z.string().min(1).max(500),
  })
  .strict()
  // Exactly one target, mirroring the DB constraint. A signal pointing at
  // nothing still counts as a signal in every downstream aggregate unless it
  // is refused here.
  .refine((s) => (s.playerName === null) !== (s.cohort === null), {
    message: 'a signal must target exactly one of playerName or cohort',
  });

export type ExtractedSignal = z.infer<typeof extractedSignalSchema>;

export const extractionResultSchema = z
  .object({
    /** Empty is a legitimate, common answer: most EA articles announce
     * content without saying anything about any player's price. An extractor
     * that never returns [] is one that has learned to invent. */
    signals: z.array(extractedSignalSchema).max(20),
  })
  .strict();

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/**
 * JSON Schema handed to the API as the output contract.
 *
 * Written out rather than generated from the Zod schema so that what the
 * model is told and what we validate are both visible in one file — and
 * because the wire format needs `additionalProperties: false` at every level,
 * which is easy to lose in a converter.
 *
 * **Structured output accepts a subset of JSON Schema.** Validation keywords
 * are rejected outright with a 400, not ignored — `maxItems` on an array and
 * `minimum`/`maximum` on a number both fail. So bounds live in `description`
 * (which the model reads) and are enforced by the Zod schema above on the way
 * back in, which is the side that actually protects the database. Keep this
 * file to: type, enum, properties, required, additionalProperties,
 * description.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['signals'],
  properties: {
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'direction',
          'magnitude',
          'confidence',
          'playerName',
          'cohort',
          'evidence',
          'rationale',
        ],
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'unclear'],
            description: 'Which way this moves the price of the target.',
          },
          magnitude: {
            type: 'string',
            enum: ['small', 'moderate', 'large', 'unclear'],
            description:
              'Rough size of the expected move. Use "unclear" rather than guessing a size the article does not support.',
          },
          confidence: {
            type: 'number',
            description:
              'Between 0 and 1: how confident you are that this signal is genuinely stated or clearly implied by the article. Be conservative.',
          },
          playerName: {
            type: ['string', 'null'],
            description:
              'The player named by the article, or null when the change is trait-wide. Exactly one of playerName or cohort must be non-null.',
          },
          cohort: {
            type: ['object', 'null'],
            additionalProperties: false,
            description:
              'A group of cards affected together, e.g. every card with a given playstyle. Exactly one of playerName or cohort must be non-null.',
            properties: {
              playerName: { type: 'string' },
              playstyle: { type: 'string' },
              position: { type: 'string' },
              league: { type: 'string' },
              nation: { type: 'string' },
              club: { type: 'string' },
              cardVersion: { type: 'string' },
              ratingMin: { type: 'integer', description: 'Lowest rating in the cohort, 0-99.' },
              ratingMax: { type: 'integer', description: 'Highest rating in the cohort, 0-99.' },
            },
          },
          evidence: {
            type: 'string',
            description: 'The exact phrase from the article this is read from.',
          },
          rationale: {
            type: 'string',
            description: 'Why the phrase supports this direction and magnitude.',
          },
        },
      },
    },
  },
} as const;
