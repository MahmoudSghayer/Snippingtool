import { z } from 'zod';

import { coinPriceSchema, ingestTimestampSchema } from './ingest-bounds.js';

/**
 * Outcome of one snipe attempt. `blocked` means the governor's `allow()`
 * refused it before the adapter ever acted — that path still gets reported,
 * because it is what proves the governor is doing its job.
 */
export const SNIPE_OUTCOMES = [
  'attempted',
  'success',
  'failed',
  'too_slow',
  'blocked',
  'error',
] as const;
export type SnipeOutcome = (typeof SNIPE_OUTCOMES)[number];

/** The longest `errorCode` an attempt may carry. A client cuts a longer
 * error to this before reporting it, or the whole item is rejected. */
export const SNIPE_ERROR_CODE_MAX = 80;

/** The longest `searchMs` / `reactionMs` an attempt may carry (10 minutes).
 * A client leaves a longer one out rather than have the item rejected. */
export const SNIPE_TIMING_MAX_MS = 600_000;

/** `POST /sniping` — one row per attempt, reported by `engine/assist.ts` or
 * `engine/autobuyer.ts` after `adapter.act()` returns (or after the governor
 * blocks the attempt). Never includes listing details beyond the ids/prices
 * the user already saw in the app's own UI. */
export const snipingAttemptSchema = z
  .object({
    /** Client-generated id for this attempt, kept with it in the extension's
     * queue so a retried flush re-sends the same id and the API stores the
     * attempt once (`ON CONFLICT DO NOTHING` on `(user_id, attempt_id,
     * occurred_at)`). Optional so extensions built before it keep working;
     * their retries can still duplicate. */
    attemptId: z.string().guid().optional(),
    resourceId: z.number().int().positive(),
    tradeId: z.string().min(1).max(64).optional(), // absent when blocked pre-attempt
    targetPrice: coinPriceSchema,
    listedPrice: coinPriceSchema.nullable(),
    outcome: z.enum(SNIPE_OUTCOMES),
    latencyMs: z.number().int().min(0).nullable(),
    /** Nova AI bot only, where the time before the buy went: from sending
     * the search to the listing arriving, and from the listing arriving to
     * sending the buy. Optional so older extensions keep working. */
    searchMs: z.number().int().min(0).max(SNIPE_TIMING_MAX_MS).optional(),
    reactionMs: z.number().int().min(0).max(SNIPE_TIMING_MAX_MS).optional(),
    errorCode: z.string().min(1).max(SNIPE_ERROR_CODE_MAX).nullable(),
    occurredAt: ingestTimestampSchema,
    deviceId: z.string().guid(),
  })
  .strict();
export type SnipingAttempt = z.infer<typeof snipingAttemptSchema>;

export const reportSnipingAttemptsRequestSchema = z
  .object({
    attempts: z.array(snipingAttemptSchema).min(1).max(200),
  })
  .strict();
export type ReportSnipingAttemptsRequest = z.infer<typeof reportSnipingAttemptsRequestSchema>;
