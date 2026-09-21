// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Job-level integration test for `audit.retention` (apps/api/src/jobs/
// audit.retention.job.ts), previously untested.

import { systemConfig } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import auditRetentionJob from '../../../jobs/audit.retention.job.js';

import type { JobContext } from '../../../jobs/types.js';
import type { FastifyInstance } from 'fastify';

const noopLog: JobContext['log'] = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function jobContext(app: FastifyInstance): JobContext {
  return { db: app.db, redis: app.redis, env: app.config, mailer: app.mailer, log: noopLog };
}

async function runJob(app: FastifyInstance) {
  // @ts-expect-error -- this job never reads `job`.
  await auditRetentionJob.processor(undefined, jobContext(app));
}

function partitionName(monthsAgo: number): string {
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  return `audit_logs_y${year}m${month}`;
}

async function createAuditPartition(app: FastifyInstance, monthsAgo: number): Promise<string> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const name = partitionName(monthsAgo);
  await app.db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF audit_logs FOR VALUES FROM ('${start.toISOString().slice(0, 10)}') TO ('${end.toISOString().slice(0, 10)}')`,
    ),
  );
  return name;
}

// `name` is always this file's own `partitionName()` output (never request
// input) — the project lint preset (packages/config/eslint-preset.js)
// forbids interpolating a value into a Drizzle `sql` tagged template at
// all, so a value comparison like this one goes through `sql.raw()` with a
// validated literal instead, same convention as jobs/audit.retention.job.ts.
async function tableExists(app: FastifyInstance, name: string): Promise<boolean> {
  if (!/^audit_logs_y\d{4}m\d{2}$/.test(name))
    throw new Error(
      `refusing to interpolate an unexpected identifier-shaped string into SQL: ${name}`,
    );
  const rows = (await app.db.execute(
    sql.raw(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${name}'`),
  )) as unknown as unknown[];
  return rows.length > 0;
}

describe('audit.retention job', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const { buildApp } = await import('../../../app.js');
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  it('drops a partition older than the configured retention window and keeps one inside it', async () => {
    await app.db
      .insert(systemConfig)
      .values({ key: 'audit.retention_months', value: 6, isSecret: false });

    const oldPartition = await createAuditPartition(app, 10); // older than 6-month retention -> should be dropped
    const recentPartition = await createAuditPartition(app, 2); // inside retention -> must survive

    await runJob(app);

    expect(
      await tableExists(app, oldPartition),
      `expected ${oldPartition} (older than retention) to be dropped`,
    ).toBe(false);
    expect(
      await tableExists(app, recentPartition),
      `expected ${recentPartition} (inside retention) to survive`,
    ).toBe(true);
  });

  it('falls back to the documented 13-month default when system_config has no configured value', async () => {
    // No `audit.retention_months` row inserted this time.
    const veryOld = await createAuditPartition(app, 20); // older than the 13-month default -> dropped
    const withinDefault = await createAuditPartition(app, 5); // inside the 13-month default -> survives

    await runJob(app);

    expect(await tableExists(app, veryOld)).toBe(false);
    expect(await tableExists(app, withinDefault)).toBe(true);
  });

  it("is idempotent and never touches the current month's partition", async () => {
    await app.db
      .insert(systemConfig)
      .values({ key: 'audit.retention_months', value: 1, isSecret: false });
    const current = await createAuditPartition(app, 0);

    await runJob(app);
    await expect(runJob(app)).resolves.toBeUndefined();

    expect(
      await tableExists(app, current),
      'the current month partition must never be dropped by retention',
    ).toBe(true);
  });
});
