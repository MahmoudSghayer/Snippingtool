import { z } from 'zod';

/**
 * Bounds on client-supplied values at every extension ingest endpoint.
 *
 * Timestamps: the extension stamps events with the user's own clock, and
 * `sniping_activity`/`user_activity`/`search_activity` are range-partitioned
 * by month on that value. A far-future timestamp used to land in the
 * table's DEFAULT partition, and from then on `partitions.maintain` could no
 * longer create that month's partition (Postgres refuses while the default
 * holds rows for the new range). Five minutes ahead absorbs ordinary clock
 * skew; seven days back covers a queue that sat in `storage.local` over a
 * long weekend, and nothing older is worth re-deriving rollups for.
 *
 * Prices: EA caps a Buy Now price at 15,000,000 coins, so anything larger is
 * a bug or a forgery — and before this bound an int4 overflow 500'd the
 * whole batch.
 */
export const INGEST_MAX_FUTURE_MS = 5 * 60 * 1000;
export const INGEST_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_COIN_PRICE = 15_000_000;

/** Whether an ISO timestamp falls inside the ingest window, relative to
 * `now`. The extension uses this too, to drop queued items the API would
 * reject anyway instead of failing a whole batch over one of them. */
export function isWithinIngestWindow(iso: string, now: number = Date.now()): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= now + INGEST_MAX_FUTURE_MS && at >= now - INGEST_MAX_PAST_MS;
}

/** An ISO datetime inside the ingest window, checked at parse time. */
export const ingestTimestampSchema = z
  .string()
  .datetime()
  .refine((v) => isWithinIngestWindow(v), {
    message: 'Must be no more than 5 minutes in the future and no more than 7 days in the past.',
  });

/** Whole coins, 0..15,000,000. */
export const coinPriceSchema = z.number().int().min(0).max(MAX_COIN_PRICE);
