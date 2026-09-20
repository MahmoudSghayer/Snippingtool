import { z } from 'zod';

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

/** `POST /sniping` — one row per attempt, reported by `engine/assist.ts` or
 * `engine/autobuyer.ts` after `adapter.act()` returns (or after the governor
 * blocks the attempt). Never includes listing details beyond the ids/prices
 * the user already saw in the app's own UI. */
export const snipingAttemptSchema = z.object({
  resourceId: z.number().int().positive(),
  tradeId: z.string().min(1).max(64).optional(), // absent when blocked pre-attempt
  targetPrice: z.number().int().min(0),
  listedPrice: z.number().int().min(0).nullable(),
  outcome: z.enum(SNIPE_OUTCOMES),
  latencyMs: z.number().int().min(0).nullable(),
  errorCode: z.string().min(1).max(80).nullable(),
  occurredAt: z.string().datetime(),
  deviceId: z.string().uuid(),
});
export type SnipingAttempt = z.infer<typeof snipingAttemptSchema>;

export const reportSnipingAttemptsRequestSchema = z.object({
  attempts: z.array(snipingAttemptSchema).min(1).max(200),
});
export type ReportSnipingAttemptsRequest = z.infer<typeof reportSnipingAttemptsRequestSchema>;
