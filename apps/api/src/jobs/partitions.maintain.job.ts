// Nightly: creates the next 3 months of partitions for every declaratively
// partitioned table, using the `create_month_partitions()` Postgres function
// migrations/0001 defines (idempotent — CREATE TABLE IF NOT EXISTS). Its
// three arguments are plain `text`, `date` and `int` values, so the call is
// built from constant SQL chunks plus bound parameters (`sql.join` +
// `sql.param`) — no `sql.raw()`, no interpolation, exactly the shape both
// the eslint preset and `.github/semgrep/rules.yml` require
// (docs/09-security.md "SQL injection prevention").

import { sql } from 'drizzle-orm';

import { defineJob } from './types.js';

const PARTITIONED_TABLES = [
  'audit_logs',
  'user_activity',
  'search_activity',
  'sniping_activity',
  // 0027_market_intelligence.sql. Without it here, price_observations would
  // quietly fall into its DEFAULT partition once the 13 months created by
  // that migration run out — still correct, but unpartitioned in practice.
  'price_observations',
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

    // Defense-in-depth even though the value is internally computed (never
    // request input): assert its shape before it is bound, so a clock or
    // formatting surprise fails loudly here rather than inside Postgres.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromMonth)) {
      throw new Error(`partitions.maintain: unexpected fromMonth value: ${fromMonth}`);
    }

    for (const table of PARTITIONED_TABLES) {
      // `create_month_partitions(parent text, from_month date, months int)`:
      // the table name is a text argument (the function quotes the
      // identifier itself), so all three values bind as $1/$2/$3.
      await db.execute(
        sql.join([
          sql`SELECT create_month_partitions(`,
          sql.param(table),
          sql`, `,
          sql.param(fromMonth),
          sql`::date, `,
          sql.param(MONTHS_AHEAD),
          sql`)`,
        ]),
      );
    }

    log.info(
      { tables: PARTITIONED_TABLES, fromMonth, monthsAhead: MONTHS_AHEAD },
      'partitions.maintain complete',
    );
  },
});
