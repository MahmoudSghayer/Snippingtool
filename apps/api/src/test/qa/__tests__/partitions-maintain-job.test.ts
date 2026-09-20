// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Job-level integration test for `partitions.maintain` (apps/api/src/jobs/
// partitions.maintain.job.ts), previously untested.

import { resetDatabase } from '@sl/db/test-utils';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import partitionsMaintainJob from '../../../jobs/partitions.maintain.job.js';

import type { JobContext } from '../../../jobs/types.js';
import type { FastifyInstance } from 'fastify';

const noopLog: JobContext['log'] = { info: () => undefined, warn: () => undefined, error: () => undefined };

function jobContext(app: FastifyInstance): JobContext {
  return { db: app.db, redis: app.redis, env: app.config, mailer: app.mailer, log: noopLog };
}

async function runJob(app: FastifyInstance) {
  // @ts-expect-error -- this job never reads `job`.
  await partitionsMaintainJob.processor(undefined, jobContext(app));
}

const PARTITIONED_TABLES = ['audit_logs', 'user_activity', 'search_activity', 'sniping_activity'] as const;

function partitionName(table: string, monthsFromNow: number): string {
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1));
  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  return `${table}_y${year}m${month}`;
}

// `name` is always this file's own `partitionName()` output (never request
// input), asserted below before ever reaching `sql.raw()` — the project
// lint preset (packages/config/eslint-preset.js) forbids interpolating a
// value into a Drizzle `sql` tagged template at all, so a value comparison
// like this one has to go through `sql.raw()` with a validated literal
// instead, same convention jobs/partitions.maintain.job.ts itself uses.
function assertSafePartitionName(name: string): void {
  if (!/^[a-z_]+_y\d{4}m\d{2}$/.test(name)) {
    throw new Error(`refusing to interpolate an unexpected identifier-shaped string into SQL: ${name}`);
  }
}

async function tableExists(app: FastifyInstance, name: string): Promise<boolean> {
  assertSafePartitionName(name);
  const rows = (await app.db.execute(sql.raw(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${name}'`))) as unknown as unknown[];
  return rows.length > 0;
}

describe('partitions.maintain job', () => {
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

  it('creates the current month plus the next 3 months of partitions for every partitioned table', async () => {
    await runJob(app);

    for (const table of PARTITIONED_TABLES) {
      for (let monthsAhead = 0; monthsAhead < 3; monthsAhead++) {
        const name = partitionName(table, monthsAhead);
        expect(await tableExists(app, name), `expected partition "${name}" to exist after partitions.maintain`).toBe(true);
      }
    }
  });

  it('is idempotent: re-running does not fail and does not duplicate/drop existing partitions', async () => {
    await runJob(app);
    await expect(runJob(app)).resolves.toBeUndefined();
    await expect(runJob(app)).resolves.toBeUndefined();

    // Spot-check one partition is still exactly one table (CREATE TABLE IF NOT EXISTS, not an error, not a duplicate).
    const name = partitionName('user_activity', 0);
    assertSafePartitionName(name);
    const rows = (await app.db.execute(
      sql.raw(`SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public' AND tablename = '${name}'`),
    )) as unknown as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(1);
  });

  it('a row for the current month routes into the newly created partition, not the default catch-all', async () => {
    await runJob(app);

    const { users } = await import('@sl/db');
    const { hashSecret } = await import('../../../lib/crypto.js');
    const { newId } = await import('../../../lib/ids.js');
    const userId = newId();
    await app.db.insert(users).values({ id: userId, email: 'partition-routing@example.com', passwordHash: await hashSecret('irrelevant-password-123'), emailVerifiedAt: new Date() });

    const { userActivity } = await import('@sl/db');
    const rowId = newId();
    await app.db.insert(userActivity).values({ id: rowId, userId, type: 'login', occurredAt: new Date() });

    const currentPartition = partitionName('user_activity', 0);
    assertSafePartitionName(currentPartition);
    if (!/^[0-9a-f-]{36}$/.test(rowId)) throw new Error(`refusing to interpolate an unexpected id-shaped string into SQL: ${rowId}`);
    const rows = (await app.db.execute(
      sql.raw(`SELECT 1 FROM "${currentPartition}" WHERE id = '${rowId}'`),
    )) as unknown as unknown[];
    expect(rows, `expected the just-inserted row to be routed into "${currentPartition}"`).toHaveLength(1);
  });
});
