/*
 * perf.ts — lightweight, opt-in timing for the extension's hot paths (the
 * Nova AI page's open and renders, the catalog, the player search, Gallery
 * mode's fut.gg work, the background's catalog handlers).
 *
 * Off by default: every call is one boolean check and the wrapped function
 * runs as it would without this file. On, each timed operation records its
 * name and duration (ms) into a bounded ring, and counters note the work
 * that was *skipped* (a poll not sent while hidden, a catalog answer
 * discarded as unchanged, a fut.gg fetch joined instead of duplicated), so a
 * trace can show both what cost time and what no longer runs. Names and
 * durations only — never a card, a search or anything of the user's.
 *
 * Turn on from DevTools in any context with `globalThis.__slPerf = true`
 * before the page opens (or `perf.enable(true)` from a test), then read
 * `perf.snapshot()`; `storage.local`'s `sl.perf.v1 = true` turns it on at
 * boot for the content script and the service worker (lib/perf-flag.ts).
 */

export interface PerfEntry {
  name: string;
  /** Duration in ms, `performance.now()` resolution. */
  ms: number;
  /** When it ended, `performance.now()` time origin. */
  at: number;
}

export interface PerfSnapshot {
  entries: PerfEntry[];
  counts: Record<string, number>;
  /** Per name: how many timings, their total and the worst one. */
  summary: Record<string, { n: number; total: number; max: number; mean: number }>;
}

const RING = 500;

declare global {
  var __slPerf: boolean | undefined;
}

let on = typeof globalThis !== 'undefined' && globalThis.__slPerf === true;
let entries: PerfEntry[] = [];
let head = 0;
let counts: Record<string, number> = {};
const marks = new Map<string, number>();

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function record(name: string, start: number): void {
  const end = now();
  const entry = { name, ms: end - start, at: end };
  if (entries.length < RING) entries.push(entry);
  else {
    entries[head] = entry;
    head = (head + 1) % RING;
  }
  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    try {
      performance.measure(`sl:${name}`, { start, end });
    } catch {
      /* an older performance API: the ring is enough */
    }
  }
}

export const perf = {
  enabled(): boolean {
    return on;
  },
  enable(value: boolean): void {
    on = value;
    globalThis.__slPerf = value;
  },
  /** Times a synchronous `fn` under `name`. */
  time<T>(name: string, fn: () => T): T {
    if (!on) return fn();
    const start = now();
    try {
      return fn();
    } finally {
      record(name, start);
    }
  },
  /** Times an async `fn` under `name` (to its settlement, success or not). */
  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!on) return fn();
    const start = now();
    try {
      return await fn();
    } finally {
      record(name, start);
    }
  },
  /** Starts a span to be ended by `end(name)` — for work that spans
   * callbacks (a click to the frame the page is drawn in). */
  start(name: string): void {
    if (on) marks.set(name, now());
  },
  end(name: string): void {
    if (!on) return;
    const start = marks.get(name);
    if (start === undefined) return;
    marks.delete(name);
    record(name, start);
  },
  /** Counts an event: work skipped, deduplicated, discarded or failed. */
  count(name: string, by = 1): void {
    if (on) counts[name] = (counts[name] ?? 0) + by;
  },
  snapshot(): PerfSnapshot {
    const ordered = entries.length < RING ? [...entries] : [...entries.slice(head), ...entries.slice(0, head)];
    const summary: PerfSnapshot['summary'] = {};
    for (const e of ordered) {
      const s = (summary[e.name] ??= { n: 0, total: 0, max: 0, mean: 0 });
      s.n++;
      s.total += e.ms;
      if (e.ms > s.max) s.max = e.ms;
    }
    for (const s of Object.values(summary)) s.mean = s.total / s.n;
    return { entries: ordered, counts: { ...counts }, summary };
  },
  reset(): void {
    entries = [];
    head = 0;
    counts = {};
    marks.clear();
  },
};
