// Nightly: creates the next 3 months of partitions for every declaratively
// partitioned table, using the `create_month_partitions()` Postgres function
// migrations/0001 defines (idempotent — CREATE TABLE IF NOT EXISTS). Values
// embedded below (table names, the computed month) are all determined by
// this file's own code, never by request input, so building the call via
// `sql.raw()` is the eslint preset's sanctioned pattern, not a shortcut
// around it.

import { sql } from 'drizzle-orm';

import { defineJob } from './types.js';

const PARTITIONED_TABLES = ['audit_logs', 'user_activity', 'search_activity', 'sniping_activity'] as const;
const MONTHS_AHEAD = 3;

export default defineJob({
  name: 'partitions.maintain',
  schedule: '0 4 * * *', // nightly at 04:00 UTC
  async processor(_job, { db, log }) {
    const now = new Date();
    const fromMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

    for (const table of PARTITIONED_TABLES) {
      await db.execute(sql.raw(`SELECT create_month_partitions('${table}', '${fromMonth}'::date, ${MONTHS_AHEAD})`));
    }

    log.info({ tables: PARTITIONED_TABLES, fromMonth, monthsAhead: MONTHS_AHEAD }, 'partitions.maintain complete');
  },
});
