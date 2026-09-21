// Nightly, 02:00 UTC: materialises every analytics metric for *yesterday*
// (UTC) into `analytics_daily` (upsert on (day, metric, dimension) — see
// src/lib/analytics/materialize.ts) and refreshes `mv_kpi_daily`. Runs
// after `profits.rollup` (hourly, so yesterday's `profits` rows are long
// since finalised by 02:00) and after `subscriptions.expire`/
// `licenses.revalidate` (05-minute schedules), so yesterday's subscription
// lifecycle events have already landed by the time this reads them.
// Idempotent: re-running for the same day recomputes and overwrites the
// same rows (see materialize.test.ts).

import { materializeDay, refreshMvKpiDaily } from '../lib/analytics/materialize.js';

import { defineJob } from './types.js';

function yesterdayUtc(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 24 * 60 * 60 * 1000,
  );
  return d.toISOString().slice(0, 10);
}

export default defineJob({
  name: 'analytics.daily',
  schedule: '0 2 * * *', // 02:00 UTC nightly
  async processor(_job, { db, log }) {
    const day = yesterdayUtc(new Date());
    const rowCount = await materializeDay(db, day);
    await refreshMvKpiDaily(db);
    log.info({ day, rowCount }, 'analytics.daily complete');
  },
});
