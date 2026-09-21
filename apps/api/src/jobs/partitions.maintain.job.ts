// Nightly: creates the next 3 months of partitions for every declaratively
// partitioned table, using the `create_month_partitions()` Postgres function
// migrations/0001 defines (idempotent — CREATE TABLE IF NOT EXISTS). Values
// embedded below (table names, the computed month) are all determined by
// this file's own code, never by request input, so building the call via
// `sql.raw()` is the eslint preset's sanctioned pattern, not a shortcut
// around it.

import { sql } from 'drizzle-orm';

import { defineJob } from './types.js';

const PARTITIONED_TABLES = [
  'audit_logs',
  'user_activity',
  'search_activity',
  'sniping_activity',
] as const;
const MONTHS_AHEAD = 3;

export default defineJob({
  name: 'partitions.maintain',
  schedule: '0 4 * * *', // nightly at 04:00 UTC
  async processor(_job, { db, log }) {
    const now = new Date();
    const fromMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);

    // Defense-in-depth even though both values are internally computed
    // (never request input): assert their shape before they're ever allowed
    // near sql.raw(), same reasoning as jobs/audit.retention.job.ts.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromMonth)) {
      throw new Error(`partitions.maintain: unexpected fromMonth value: ${fromMonth}`);
    }

    for (const table of PARTITIONED_TABLES) {
      // `create_month_partitions` is a Postgres function whose table-name
      // argument is a regclass-like identifier, not parameterisable via
      // Drizzle's `sql` template the usual way for this call shape; `table`
      // only ever comes from the fixed PARTITIONED_TABLES literal above and
      // `fromMonth` is validated immediately above, neither is
      // request-controlled. See docs/09-security.md "No string-interpolated
      // SQL".
      await db.execute(
        sql.raw(
          `SELECT create_month_partitions('${table}', '${fromMonth}'::date, ${MONTHS_AHEAD})`,
        ),
      ); // nosemgrep: no-raw-sql-string-interpolation
    }

    log.info(
      { tables: PARTITIONED_TABLES, fromMonth, monthsAhead: MONTHS_AHEAD },
      'partitions.maintain complete',
    );
  },
});
