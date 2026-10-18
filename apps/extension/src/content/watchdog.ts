/*
 * watchdog.ts — notices a MAIN-world adapter that has gone quiet: no probe
 * result and no heartbeat (main/adapter.ts sends one every 20 s) for longer
 * than it should take. Chrome-free.
 *
 * It used to warn on any minute without a probe result. The adapter only
 * reports one on an act call, so every idle minute — and every pause of the
 * bot's — read as a stall, and a background tab's throttled timers made it
 * worse: thousands of false warnings a day. Now:
 *
 *   - the adapter's heartbeat counts as hearing from it;
 *   - a hidden tab gets a much longer allowance (`hiddenStaleMs`): Chrome
 *     runs both worlds' timers about once a minute there, so a minute of
 *     silence proves nothing;
 *   - a check that itself ran late (its timer held up by throttling, a
 *     frozen page, a sleeping laptop) counts for nothing, since the
 *     adapter's timers were held up just the same, and nor does the first
 *     check after the tab is shown or hidden;
 *   - it warns only after `misses` checks in a row found the adapter quiet;
 *   - once per stall, as before (P0 Task 13), and at most once every
 *     `minWarnGapMs` across stalls: a real stall is still reported, a page
 *     that keeps going quiet is not reported every time.
 */
export interface Watchdog {
  /** The adapter was heard from. */
  seen(): void;
  /** Run on an interval (every `checkMs`): warns when the adapter has been
   * quiet too long. */
  check(): void;
}

export interface WatchdogOptions {
  /** Quiet for longer than this, in a visible tab, is a miss. */
  staleMs: number;
  /** The same in a hidden tab. Default: five times `staleMs`. */
  hiddenStaleMs?: number;
  /** How often `check` is meant to run. */
  checkMs: number;
  /** Misses in a row before it warns. Default 3. */
  misses?: number;
  /** The shortest time between two warnings. Default 10 minutes. */
  minWarnGapMs?: number;
  /** Whether the page is hidden now (document.visibilityState). */
  isHidden?: () => boolean;
  /** `quietMs`: how long the adapter has been quiet. */
  warn: (quietMs: number) => void;
  recovered?: () => void;
  now?: () => number;
}

export const WATCHDOG_DEFAULT_MISSES = 3;
export const WATCHDOG_DEFAULT_MIN_WARN_GAP_MS = 10 * 60_000;

export function createWatchdog(opts: WatchdogOptions): Watchdog {
  const now = opts.now ?? Date.now;
  const isHidden = opts.isHidden ?? (() => false);
  const hiddenStaleMs = opts.hiddenStaleMs ?? opts.staleMs * 5;
  const missesToWarn = Math.max(1, opts.misses ?? WATCHDOG_DEFAULT_MISSES);
  const minWarnGapMs = opts.minWarnGapMs ?? WATCHDOG_DEFAULT_MIN_WARN_GAP_MS;
  let lastSeen = now();
  let lastCheckAt = lastSeen;
  let lastHidden = isHidden();
  let misses = 0;
  /** Warned during the current stall (cleared when the adapter is heard). */
  let warned = false;
  let lastWarnAt = -Infinity;

  return {
    seen() {
      lastSeen = now();
      misses = 0;
      if (warned) {
        warned = false;
        opts.recovered?.();
      }
    },
    check() {
      const t = now();
      const sinceCheck = t - lastCheckAt;
      lastCheckAt = t;
      const hidden = isHidden();
      const stale = hidden ? hiddenStaleMs : opts.staleMs;
      const switched = hidden !== lastHidden;
      lastHidden = hidden;
      // This check ran far later than asked, or the tab was just shown or
      // hidden: whatever held this timer up held the adapter's too, so its
      // silence proves nothing yet. Start counting again.
      if (switched || sinceCheck > Math.max(2 * opts.checkMs, stale)) {
        misses = 0;
        return;
      }
      const quietMs = t - lastSeen;
      if (quietMs <= stale) {
        misses = 0;
        return;
      }
      if (++misses < missesToWarn || warned || t - lastWarnAt < minWarnGapMs) return;
      warned = true;
      lastWarnAt = t;
      opts.warn(quietMs);
    },
  };
}
