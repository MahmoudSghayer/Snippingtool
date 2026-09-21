#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI script */
// Backfills `analytics_daily` for every UTC day in [--from, --to] (--to
// defaults to today), then refreshes `mv_kpi_daily` once at the end. Run
// via `pnpm --filter @sl/api analytics:backfill --from 2026-01-01 [--to
// 2026-06-30]`. Idempotent per day (materializeDay upserts), and safe to
// re-run over a range that overlaps previously materialised days — see
// docs/08-analytics.md "Materialisation" for the day-by-day snapshot
// caveat on subscription-derived metrics.

import { createDb } from '@sl/db';
import 'dotenv/config';

import { loadEnv } from '../../config/env.js';

import { listDays } from './dates.js';
import { materializeDay, refreshMvKpiDaily } from './materialize.js';

function parseArgs(argv: string[]): { from: string; to: string } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        args.set(key, value);
        i++;
      }
    }
  }
  const from = args.get('from');
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error('Usage: analytics:backfill --from YYYY-MM-DD [--to YYYY-MM-DD]');
  }
  const to = args.get('to') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('--to must be YYYY-MM-DD');
  }
  return { from, to };
}

export async function runBackfill(
  from: string,
  to: string,
): Promise<{ days: number; rows: number }> {
  const env = loadEnv();
  const { db, sql } = createDb(env.DATABASE_URL, { max: 5 });
  try {
    let totalRows = 0;
    let days = 0;
    for (const day of listDays(from, to)) {
      const rowCount = await materializeDay(db, day);
      totalRows += rowCount;
      days++;
      console.log(`analytics:backfill ${day}: ${rowCount} rows`);
    }
    await refreshMvKpiDaily(db);
    console.log(
      `analytics:backfill complete: ${days} day(s), ${totalRows} row(s) upserted, mv_kpi_daily refreshed.`,
    );
    return { days, rows: totalRows };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const { from, to } = parseArgs(process.argv.slice(2));
  await runBackfill(from, to);
}

// Only run as a CLI entrypoint (`tsx backfill.ts`), not when imported by a
// test that wants `runBackfill` directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
