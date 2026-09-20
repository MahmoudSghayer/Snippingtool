/*
 * types.ts — lightweight shapes shared by `engine/assist.ts` and
 * `engine/autobuyer.ts`. Deliberately *not* the full `@sl/shared`
 * `SnipingAttempt`/`Trade` schemas: those require `deviceId`/`occurredAt`/
 * `id`/`eaTax` that only `content/index.ts` (which owns the device
 * registration and session) can fill in. Keeping the engine layer's own
 * inputs minimal is what lets `assist.ts`/`autobuyer.ts` stay ignorant of
 * device/session bookkeeping entirely.
 */
import type { SnipeOutcome } from '@sl/shared';

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
