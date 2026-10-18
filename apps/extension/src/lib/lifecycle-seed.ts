/*
 * lifecycle-seed.ts — when the trade lifecycle (lib/trade-lifecycle.ts)
 * asks the account for its open trades (`GET /api/v1/extension/open-trades`)
 * and adds them to this browser's records (`TradeLifecycle.seed`), so a
 * card bought in another browser is followed here and its sale reported.
 *
 * Background asks at boot (once signed in), when the bot starts, every 15
 * minutes while it runs, and before a trade-pile read it would otherwise
 * judge on stale records (background/lifecycle.ts). This keeps those to one
 * request at a time and at most one every `SEED_EVERY_MS`: each caller
 * says how old the last seed may be. After a failed ask (signed out,
 * offline, refused) the next waits `SEED_RETRY_MS`.
 *
 * No chrome APIs (the userscript build reuses it): the fetch and the store
 * for the last seed's time are handed in.
 */
import type { TradeLifecycle } from './trade-lifecycle.js';
import type { OpenTradesResponse } from '@sl/shared';

/** How often the open trades are read while the bot runs. */
export const SEED_EVERY_MS = 15 * 60_000;
/** The wait after an ask that got no answer. */
export const SEED_RETRY_MS = 2 * 60_000;

export interface LifecycleSeederDeps {
  lifecycle: Pick<TradeLifecycle, 'seed'>;
  /** The account's open trades, or null when they could not be asked for
   * (signed out, offline, refused). */
  fetchOpenTrades: () => Promise<OpenTradesResponse | null>;
  /** Where the last successful seed's time is kept, so a restarted service
   * worker does not ask again at once. In memory without one. */
  lastSeeded?: { get(): Promise<number>; set(at: number): Promise<void> };
  now?: () => number;
}

export interface LifecycleSeeder {
  /** Seeds unless the last seed is younger than `maxAgeMs` (or an ask
   * failed less than `SEED_RETRY_MS` ago). Joins a seed already under way.
   * Resolves to the records added, 0 when it did not ask or got no answer;
   * never rejects. */
  run(maxAgeMs?: number): Promise<number>;
}

export function createLifecycleSeeder(deps: LifecycleSeederDeps): LifecycleSeeder {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<number> | null = null;
  let lastSeededAt: number | null = null;
  let lastFailedAt = Number.NEGATIVE_INFINITY;

  async function seedOnce(maxAgeMs: number): Promise<number> {
    if (lastSeededAt === null) {
      const stored = deps.lastSeeded ? await deps.lastSeeded.get().catch(() => 0) : 0;
      lastSeededAt = Number.isFinite(stored) ? stored : 0;
    }
    const at = now();
    // A stored time in the future (a clock moved back) never blocks a seed.
    if (lastSeededAt <= at && at - lastSeededAt < maxAgeMs) return 0;
    if (at - lastFailedAt < Math.min(SEED_RETRY_MS, maxAgeMs)) return 0;

    const open = await deps.fetchOpenTrades().catch(() => null);
    if (!open) {
      lastFailedAt = now();
      return 0;
    }
    // A truncated list (more open trades than the API returns) cannot say
    // which trades are no longer open.
    const added = await deps.lifecycle.seed(open.items, { complete: !open.truncated });
    lastSeededAt = now();
    await deps.lastSeeded?.set(lastSeededAt).catch(() => undefined);
    return added;
  }

  return {
    run(maxAgeMs = SEED_EVERY_MS) {
      inFlight ??= seedOnce(maxAgeMs)
        .catch(() => {
          // The store failed: retried like an ask that got no answer.
          lastFailedAt = now();
          return 0;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
