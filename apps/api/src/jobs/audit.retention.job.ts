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
      // Identifier is derived solely from date arithmetic above, never from
      // request input — sql.raw() with a programmatically built (not
      // request-controlled) identifier, no bound params needed.
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
    }

    log.info({ retentionMonths, cutoff: cutoff.toISOString() }, `audit.retention checked ${LOOKBACK_MONTHS_TO_CHECK} candidate partitions`);
  },
});
