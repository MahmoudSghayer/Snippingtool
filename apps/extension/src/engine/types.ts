/*
 * types.ts — lightweight shapes shared by `engine/assist.ts` and
 * `engine/autobuyer.ts`. Deliberately *not* the full `@sl/shared`
 * `SnipingAttempt`/`Trade` schemas: those require `deviceId`/`occurredAt`/
 * `id`/`eaTax` that only `content/index.ts` (which owns the device
 * registration and session) can fill in. Keeping the engine layer's own
 * inputs minimal is what lets `assist.ts`/`autobuyer.ts` stay ignorant of
 * device/session bookkeeping entirely. `attemptErrorCode` keeps an
 * attempt's error inside the schema's bound, for every engine.
 */
import { SNIPE_ERROR_CODE_MAX, type SnipeOutcome } from '@sl/shared';

/** An error as an attempt's `errorCode`: never empty, and cut to what the
 * schema allows (`SNIPE_ERROR_CODE_MAX`), or background would reject the
 * whole item. */
export function attemptErrorCode(error: string | null | undefined): string {
  return (error || 'unknown_error').slice(0, SNIPE_ERROR_CODE_MAX);
}

export interface AttemptInput {
  resourceId: number;
  tradeId?: string;
  targetPrice: number;
  listedPrice: number | null;
  outcome: SnipeOutcome;
  latencyMs: number | null;
  errorCode: string | null;
}

export interface TradeInput {
  tradeId: string;
  resourceId: number;
  buyPrice: number;
}
