// Hourly backstop: recomputes today's `profits` row for every user with
// trade or sniping activity today. The ingest routes already roll up the
// days they touch synchronously (see lib/analytics/rollup.ts), so this job
// only exists to self-heal — a crashed request between the trade insert
// and its rollup, or a row edited directly in the database, converges by
// the next hour.

import { rollupProfitsForDay, utcDay } from '../lib/analytics/rollup.js';

import { defineJob } from './types.js';

export default defineJob({
  name: 'profits.rollup',
  schedule: '7 * * * *', // hourly, offset a few minutes past the hour
  async processor(_job, { db, log }) {
    const day = utcDay(new Date());
    const usersRolledUp = await rollupProfitsForDay(db, day);
    log.info({ day, usersRolledUp }, 'profits.rollup complete');
  },
});
