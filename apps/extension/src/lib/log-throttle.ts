/*
 * log-throttle.ts — at most one log line per key every so often, for the
 * warnings that can repeat on every EA answer: an EA error on every search
 * while EA rate-limits the account, a trade-pile shape change on every
 * reload of the transfer list. Every warning becomes an error report on the
 * server (lib/errors.ts), where the same line every few seconds is noise
 * that buries the news. Chrome-free.
 */

/** Keys remembered at most; the oldest is forgotten first. */
const MAX_KEYS = 200;

/**
 * Returns a gate: `gate(key)` is null while a line for `key` went out less
 * than `minGapMs` ago (the line should be dropped), and otherwise the
 * number of lines dropped for `key` since the last one that went out (so
 * the line can say "and N more").
 */
export function createLogThrottle(minGapMs: number, now: () => number = Date.now): (key: string) => number | null {
  const last = new Map<string, { at: number; dropped: number }>();
  return (key) => {
    const t = now();
    const entry = last.get(key);
    if (entry && t - entry.at < minGapMs) {
      entry.dropped++;
      return null;
    }
    last.delete(key);
    last.set(key, { at: t, dropped: 0 });
    if (last.size > MAX_KEYS) last.delete(last.keys().next().value!);
    return entry?.dropped ?? 0;
  };
}

/** " (and N more like it since)" for a throttled line, or nothing. */
export function droppedSuffix(dropped: number): string {
  return dropped > 0 ? ` (and ${dropped} more like it since)` : '';
}
