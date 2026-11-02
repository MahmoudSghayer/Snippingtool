// The performance harness behind test/perf/*.bench.test.ts: times an
// operation a few times, keeps the median (robust to one slow run on a busy
// CI box), prints a table, and writes the numbers to
// test-results/perf/<suite>.json so scripts/perf-report.mjs can set a run
// against test/perf/baseline/*.json (captured before the optimisation).
//
// These are measurements under vitest's jsdom, not a browser profile: they
// show the relative cost of the code paths and catch regressions, which is
// what they are for. The ceilings the suites assert are deliberately loose.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BenchResult {
  name: string;
  /** Median of the timed runs, ms. */
  ms: number;
  /** Slowest run, ms. */
  max: number;
  runs: number;
  /** Any count worth keeping next to the time (fetches made, rows drawn...). */
  meta?: Record<string, number>;
}

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-results', 'perf');

const nowMs = (): number => performance.now();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** One suite's results, written on `flush()`. */
export function createSuite(suite: string) {
  const results: BenchResult[] = [];

  function keep(name: string, times: number[], meta?: Record<string, number>): BenchResult {
    const r: BenchResult = { name, ms: round(median(times)), max: round(Math.max(...times)), runs: times.length, ...(meta ? { meta } : {}) };
    results.push(r);
    return r;
  }

  return {
    /** Times `fn` `runs` times (after `warmup` untimed runs). `fn` may return
     * counts to keep beside the time. */
    bench(name: string, fn: () => void | Record<string, number>, { runs = 5, warmup = 1 } = {}): BenchResult {
      let meta: Record<string, number> | undefined;
      for (let i = 0; i < warmup; i++) fn();
      const times: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t = nowMs();
        const out = fn();
        times.push(nowMs() - t);
        if (out) meta = out;
      }
      return keep(name, times, meta);
    },
    async benchAsync(name: string, fn: () => Promise<void | Record<string, number>>, { runs = 5, warmup = 1 } = {}): Promise<BenchResult> {
      let meta: Record<string, number> | undefined;
      for (let i = 0; i < warmup; i++) await fn();
      const times: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t = nowMs();
        const out = await fn();
        times.push(nowMs() - t);
        if (out) meta = out;
      }
      return keep(name, times, meta);
    },
    /** A single already-measured number (a one-off cold path). */
    record(name: string, ms: number, meta?: Record<string, number>): BenchResult {
      return keep(name, [ms], meta);
    },
    results,
    /** Prints the table and writes the JSON. */
    flush(): void {
      const width = Math.max(...results.map((r) => r.name.length), 10);
      const lines = results.map((r) => `${r.name.padEnd(width)}  ${String(r.ms).padStart(9)} ms  (max ${r.max} ms, n=${r.runs})${r.meta ? '  ' + JSON.stringify(r.meta) : ''}`);
      // eslint-disable-next-line no-console
      console.info(`\n[perf] ${suite}\n${lines.join('\n')}\n`);
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(path.join(OUT_DIR, `${suite}.json`), JSON.stringify({ suite, at: new Date().toISOString(), results }, null, 2) + '\n');
    },
  };
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
