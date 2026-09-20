// Error rates: extension errors reported into `user_activity` (type
// 'error', via /api/v1/extension/errors) counted over [from, to], plus the
// API's own rolling 5-minute 5xx counter already maintained in Redis by
// src/lib/error-rate.ts (read-only reuse — that file is owned by the
// backend-core agent, not edited here).

import { userActivity, type Database } from '@sl/db';
import { and, count, eq, gte, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { getErrorRate } from '../error-rate.js';

import { endOfDayUtc, parseDayUtc } from './dates.js';

export interface ErrorRateParams {
  from: string;
  to: string;
}

export interface ErrorRates {
  extensionErrorsInRange: number;
  apiServerErrorsLast5Min: number;
}

export async function getErrorRates(db: Database, redis: Redis, params: ErrorRateParams): Promise<ErrorRates> {
  const [[row], apiServerErrorsLast5Min] = await Promise.all([
    db
      .select({ n: count() })
      .from(userActivity)
      .where(and(eq(userActivity.type, 'error'), gte(userActivity.occurredAt, parseDayUtc(params.from)), lt(userActivity.occurredAt, endOfDayUtc(params.to)))),
    getErrorRate(redis, 5),
  ]);
  return { extensionErrorsInRange: row?.n ?? 0, apiServerErrorsLast5Min };
}
