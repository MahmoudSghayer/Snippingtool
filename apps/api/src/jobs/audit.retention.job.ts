// Nightly: drops audit_logs partitions older than the configured retention
// window (system_config key `audit.retention_months`, default 13 — matching
// the 13 months of partitions migrations/0020 pre-creates). Partition names
// are derived purely from date arithmetic (never from user input), so
// building the DROP TABLE statement's identifier via `sql.raw()` — the
// eslint preset's own sanctioned escape hatch for a non-parameterisable
// identifier — is safe here.

import { sql } from 'drizzle-orm';

import { defineJob } from './types.js';

const DEFAULT_RETENTION_MONTHS = 13;
const LOOKBACK_MONTHS_TO_CHECK = 36; // how far past the cutoff to look for a partition to drop

function partitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `audit_logs_y${year}m${month}`;
}

export default defineJob({
  name: 'audit.retention',
  schedule: '30 3 * * *', // nightly at 03:30 UTC
  async processor(_job, { db, log }) {
    const configRow = await db.query.systemConfig.findFirst({ where: (c, { eq }) => eq(c.key, 'audit.retention_months') });
    const retentionMonths = typeof configRow?.value === 'number' ? configRow.value : DEFAULT_RETENTION_MONTHS;

    const now = new Date();
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - retentionMonths, 1));

    for (let i = 1; i <= LOOKBACK_MONTHS_TO_CHECK; i++) {
      const target = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() - i, 1));
      const name = partitionName(target);
      // Defense-in-depth even though `name` is derived solely from date
      // arithmetic above (never request input): assert it still matches the
      // exact identifier shape `partitionName()` produces before it's ever
      // allowed near sql.raw(), so a future change to that function (or to
      // this loop) can't silently start interpolating something else.
      if (!/^audit_logs_y\d{4}m\d{2}$/.test(name)) {
        throw new Error(`audit.retention: refusing to DROP an unexpected partition identifier: ${name}`);
      }
      // DDL identifier (DROP TABLE target) can't be a bound parameter in
      // Postgres; `name` is validated immediately above against a fixed
      // regex, not request-controlled. See docs/09-security.md "No
      // string-interpolated SQL".
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`)); // nosemgrep: no-raw-sql-string-interpolation
    }

    log.info({ retentionMonths, cutoff: cutoff.toISOString() }, `audit.retention checked ${LOOKBACK_MONTHS_TO_CHECK} candidate partitions`);
  },
});
