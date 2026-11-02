#!/usr/bin/env node
// perf-report.mjs — sets the numbers a `pnpm perf` run just wrote
// (test-results/perf/*.json, from test/perf/*.bench.test.ts) against the
// baseline kept in test/perf/baseline/*.json, as one markdown table.
//
//   pnpm --filter @sl/extension perf            # run the benches, then this
//   node scripts/perf-report.mjs --update       # make the current run the baseline
//
// The baseline was captured on the unoptimised code (see docs/06-extension.md,
// "Performance"), so the table is the before/after of the optimisation; after
// `--update` it is the regression reference for the next change.
/* eslint-disable no-console -- a CLI report: its output is the console */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const current = path.join(root, 'test-results', 'perf');
const baseline = path.join(root, 'test', 'perf', 'baseline');

if (!existsSync(current)) {
  console.error('no test-results/perf: run `pnpm --filter @sl/extension perf` first');
  process.exit(1);
}

if (process.argv.includes('--update')) {
  mkdirSync(baseline, { recursive: true });
  for (const f of readdirSync(current)) if (f.endsWith('.json')) copyFileSync(path.join(current, f), path.join(baseline, f));
  console.log(`baseline updated from ${path.relative(root, current)}`);
  process.exit(0);
}

const read = (dir, f) => (existsSync(path.join(dir, f)) ? JSON.parse(readFileSync(path.join(dir, f), 'utf8')) : null);
const fmt = (ms) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));
const meta = (m) => (m ? Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ') : '');

const rows = [];
for (const f of readdirSync(current).filter((x) => x.endsWith('.json')).sort()) {
  const now = read(current, f);
  const was = read(baseline, f);
  const byName = new Map((was?.results ?? []).map((r) => [r.name, r]));
  for (const r of now.results) {
    const b = byName.get(r.name);
    const change = b ? (b.ms === 0 ? (r.ms === 0 ? '=' : 'n/a') : `${(((r.ms - b.ms) / b.ms) * 100).toFixed(0)}%`) : '(new)';
    rows.push([now.suite, r.name, b ? fmt(b.ms) : '—', fmt(r.ms), change, b ? meta(b.meta) : '', meta(r.meta)]);
  }
}
const head = ['suite', 'operation', 'before ms', 'after ms', 'change', 'before counts', 'after counts'];
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (cells) => `| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`;
console.log(line(head));
console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
for (const r of rows) console.log(line(r));
