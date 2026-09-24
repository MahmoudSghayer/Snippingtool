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

    // One table's failure must not stop the others: before the ingest
    // timestamp bounds (@sl/shared ingest-bounds.ts), a far-future row in
    // one table's DEFAULT partition made create_month_partitions() throw
    // for that table, and every table after it in this list silently
    // stopped getting partitions too. Each table is tried on its own; the
    // job still fails at the end (so BullMQ records it and retries) naming
    // every table that failed.
    const failed: string[] = [];
    for (const table of PARTITIONED_TABLES) {
      try {
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
      } catch (err) {
        failed.push(table);
        log.error(
          { table, err: err instanceof Error ? err.message : String(err) },
          'partitions.maintain: could not create partitions for table',
        );
      }

      // Rows in the DEFAULT partition are rows outside every monthly range.
      // They are still queryable, but they block creating the partition
      // that covers them, so they need moving by hand (docs/02-database.md,
      // partition maintenance runbook). `default_partition_row_count` is
      // migration 0032's helper; it quotes the identifier itself.
      try {
        const [row] = (await db.execute(
          sql.join([sql`SELECT default_partition_row_count(`, sql.param(table), sql`) AS n`]),
        )) as unknown as Array<{ n: string | number }>;
        const defaultRows = Number(row?.n ?? 0);
        if (defaultRows > 0) {
          log.error({ table, defaultRows }, 'partitions.maintain: rows in DEFAULT partition');
        }
      } catch (err) {
        log.warn(
          { table, err: err instanceof Error ? err.message : String(err) },
          'partitions.maintain: could not count DEFAULT partition rows',
        );
      }
    }

    if (failed.length > 0) {
      throw new Error(`partitions.maintain: failed for ${failed.join(', ')}`);
    }

    log.info(
      { tables: PARTITIONED_TABLES, fromMonth, monthsAhead: MONTHS_AHEAD },
      'partitions.maintain complete',
    );
  },
});
