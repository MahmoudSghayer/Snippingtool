// Hourly: recomputes *today's* (UTC) analytics_daily rows from whatever
// data exists so far — a partial-day snapshot that converges to the full
// day's numbers as more of the day's activity, trades and payments land,
// the same self-healing idempotent-upsert pattern as profits.rollup.job.ts
// (which this job depends on having already run this hour, since it reads
// from `profits`). Does not refresh `mv_kpi_daily` — that's the nightly
// job's job, once per day is enough for a materialized view most consumers
// read from a fixed "as of last night" perspective.

import { materializeDay } from '../lib/analytics/materialize.js';

import { defineJob } from './types.js';

function todayUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

export default defineJob({
  name: 'analytics.hourly',
  schedule: '20 * * * *', // hourly, offset a few minutes past profits.rollup (:07)
  async processor(_job, { db, log }) {
    const day = todayUtc(new Date());
    const rowCount = await materializeDay(db, day);
    log.info({ day, rowCount }, 'analytics.hourly complete');
  },
});
