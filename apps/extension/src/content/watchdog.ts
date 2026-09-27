/*
 * watchdog.ts — notices a MAIN-world adapter that has gone quiet (no probe
 * result for `staleMs`). Warns once per stall: the old inline check logged
 * the same warning every 15 seconds for as long as the stall lasted, which
 * buried everything else in the log (P0 Task 13). Chrome-free.
 */
export interface Watchdog {
  /** The adapter was heard from. */
  seen(): void;
  /** Run on an interval: warns when the adapter has been quiet too long. */
  check(): void;
}

export function createWatchdog(opts: {
  staleMs: number;
  warn: () => void;
  recovered?: () => void;
  now?: () => number;
}): Watchdog {
  const now = opts.now ?? Date.now;
  let lastSeen = now();
  let warned = false;
  return {
    seen() {
      lastSeen = now();
      if (warned) {
        warned = false;
        opts.recovered?.();
      }
    },
    check() {
      if (warned || now() - lastSeen <= opts.staleMs) return;
      warned = true;
      opts.warn();
    },
  };
}
