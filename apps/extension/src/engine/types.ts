/*
 * types.ts — lightweight shapes shared by `engine/assist.ts` and
 * `engine/autobuyer.ts`. Deliberately *not* the full `@sl/shared`
 * `SnipingAttempt`/`Trade` schemas: those require `deviceId`/`occurredAt`/
 * `id`/`eaTax` that only `content/index.ts` (which owns the device
 * registration and session) can fill in. Keeping the engine layer's own
 * inputs minimal is what lets `assist.ts`/`autobuyer.ts` stay ignorant of
 * device/session bookkeeping entirely. `attemptErrorCode` keeps an
 * attempt's error inside the schema's bound, for every engine, and
 * `attemptTiming` its timings.
 */
import { SNIPE_ERROR_CODE_MAX, SNIPE_TIMING_MAX_MS, type SnipeOutcome } from '@sl/shared';

/** An error as an attempt's `errorCode`: never empty, and cut to what the
 * schema allows (`SNIPE_ERROR_CODE_MAX`), or background would reject the
 * whole item. */
export function attemptErrorCode(error: string | null | undefined): string {
  return (error || 'unknown_error').slice(0, SNIPE_ERROR_CODE_MAX);
}

/** A timing as an attempt's `searchMs` / `reactionMs`: whole ms, or left
 * out when unknown or outside what the schema takes (`SNIPE_TIMING_MAX_MS`),
 * or background would reject the whole item. */
export function attemptTiming(ms: number | undefined): number | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  const whole = Math.round(ms);
  return whole >= 0 && whole <= SNIPE_TIMING_MAX_MS ? whole : undefined;
}

export interface AttemptInput {
  resourceId: number;
  tradeId?: string;
  targetPrice: number;
  listedPrice: number | null;
  outcome: SnipeOutcome;
  latencyMs: number | null;
  errorCode: string | null;
  /** Nova AI bot only: from sending the search that found the listing to
   * the listing arriving. */
  searchMs?: number;
  /** Nova AI bot only: from the listing arriving to sending the buy. */
  reactionMs?: number;
}

export interface TradeInput {
  tradeId: string;
  resourceId: number;
  buyPrice: number;
}
