// Hourly backstop: recomputes today's and yesterday's `profits` rows for
// every user with trade or sniping activity on those days. The ingest
// routes already roll up the days they touch synchronously, in the same
// transaction as their write (see lib/analytics/rollup.ts), so this job only
// exists to self-heal — a row edited directly in the database, or a late
// batch just before midnight UTC that the first run after midnight would
// otherwise never look at again.

import { rollupProfitsForDay, utcDay } from '../lib/analytics/rollup.js';

import { defineJob } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export default defineJob({
  name: 'profits.rollup',
  schedule: '7 * * * *', // hourly, offset a few minutes past the hour
  async processor(_job, { db, log }) {
    const now = Date.now();
    for (const day of [utcDay(new Date(now - DAY_MS)), utcDay(new Date(now))]) {
      const usersRolledUp = await rollupProfitsForDay(db, day);
      log.info({ day, usersRolledUp }, 'profits.rollup complete');
    }
  },
});
