/*
 * clock.ts — the server's idea of "now", for stamping ingest data.
 *
 * The API rejects an ingest timestamp more than 5 minutes ahead of its own
 * clock (packages/shared ingest-bounds.ts), and deliberately does not clamp:
 * a clamped `occurredAt` would no longer match the retried copy of the same
 * sniping attempt, and `(user_id, attempt_id, occurred_at)` is the
 * idempotency key. So a user whose machine runs fast has to be corrected on
 * this side. Bootstrap and heartbeat responses carry `serverTime`; the offset
 * to the local clock is kept here (and in `storage.local`, so a restarted
 * service worker keeps it), and `lib/telemetry.ts` applies it once, when an
 * item is queued — the persisted item already carries the corrected
 * timestamp, so every retry sends it byte-for-byte.
 *
 * Only a plain number in storage, no Chrome-only API.
 */

import { logger } from './logger.js';
import { getLocal, setLocal } from './storage.js';

const OFFSET_KEY = 'sl.clock.serverOffsetMs.v1';
/** Anything smaller is round-trip noise and not worth rewriting timestamps
 * for. */
const MIN_CORRECTION_MS = 1000;

let offsetMs = 0;
let loading: Promise<void> | null = null;

/** Loads the persisted offset once per service-worker instance. */
export function ensureClockLoaded(): Promise<void> {
  loading ??= getLocal<number>(OFFSET_KEY, 0)
    .then((stored) => {
      if (typeof stored === 'number' && Number.isFinite(stored)) offsetMs = stored;
    })
    .catch(() => undefined);
  return loading;
}

/** Records the offset from a response's `serverTime`, taking the request's
 * midpoint as the moment the server stamped it. */
export async function recordServerTime(serverTime: string | undefined, sentAt: number, receivedAt: number): Promise<void> {
  const server = Date.parse(serverTime ?? '');
  if (!Number.isFinite(server)) return;
  const next = Math.round(server - (sentAt + receivedAt) / 2);
  offsetMs = Math.abs(next) < MIN_CORRECTION_MS ? 0 : next;
  if (offsetMs !== 0) logger.debug(`local clock is ${-offsetMs} ms off the server's; correcting ingest timestamps`, 'clock');
  try {
    await setLocal(OFFSET_KEY, offsetMs);
  } catch {
    // In-memory still applies for this service-worker instance.
  }
}

/** Server-corrected `Date.now()`. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** A local-clock ISO timestamp moved onto the server's clock. Anything that
 * does not parse is returned as-is, for the API to judge. */
export function toServerTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || offsetMs === 0) return iso;
  return new Date(at + offsetMs).toISOString();
}

/** Only for tests. */
export function resetClockForTests(): void {
  offsetMs = 0;
  loading = null;
}
