// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Job-level integration test for `profits.rollup` (apps/api/src/jobs/
// profits.rollup.job.ts), previously untested (jobs/__tests__/jobs.test.ts
// only covers subscriptions.expire and abuse.scan).

import { profits, trades, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import profitsRollupJob from '../../../jobs/profits.rollup.job.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';

import type { JobContext } from '../../../jobs/types.js';
import type { FastifyInstance } from 'fastify';

const noopLog: JobContext['log'] = { info: () => undefined, warn: () => undefined, error: () => undefined };

function jobContext(app: FastifyInstance): JobContext {
  return { db: app.db, redis: app.redis, env: app.config, mailer: app.mailer, log: noopLog };
}

async function createVerifiedUser(app: FastifyInstance, email: string): Promise<string> {
  const id = newId();
  await app.db.insert(users).values({ id, email, passwordHash: await hashSecret('irrelevant-password-123'), emailVerifiedAt: new Date() });
  return id;
}

function todayUtc(hour = 12): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour));
}

async function runJob(app: FastifyInstance) {
  // @ts-expect-error -- BullMQ's Job type isn't needed by this job's body (it never reads `job`).
  await profitsRollupJob.processor(undefined, jobContext(app));
}

describe('profits.rollup job', () => {
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

  it('creates today\'s profits row from trades sold/bought today', async () => {
    const userId = await createVerifiedUser(app, 'rollup-basic@example.com');
    await app.db.insert(trades).values([
      { id: newId(), userId, tradeId: 't-1', resourceId: 'r-1', status: 'sold', buyPrice: 1_000, sellPrice: 1_500, eaTax: 75, netProfit: 425, boughtAt: todayUtc(1), soldAt: todayUtc(2) },
      { id: newId(), userId, tradeId: 't-2', resourceId: 'r-2', status: 'sold', buyPrice: 2_000, sellPrice: 2_800, eaTax: 140, netProfit: 660, boughtAt: todayUtc(3), soldAt: todayUtc(4) },
    ]);

    await runJob(app);

    const row = await app.db.query.profits.findFirst({ where: eq(profits.userId, userId) });
    expect(row).toBeDefined();
    expect(row!.coinsEarned).toBe(1_500 + 2_800);
    expect(row!.coinsSpent).toBe(1_000 + 2_000);
    expect(row!.netProfit).toBe(425 + 660);
    expect(row!.tradesClosed).toBe(2);
  });

  it('is idempotent: re-running the same hour upserts (does not double-count) rather than duplicating', async () => {
    const userId = await createVerifiedUser(app, 'rollup-idempotent@example.com');
    await app.db.insert(trades).values([
      { id: newId(), userId, tradeId: 't-idem', resourceId: 'r-idem', status: 'sold', buyPrice: 500, sellPrice: 900, eaTax: 45, netProfit: 355, boughtAt: todayUtc(1), soldAt: todayUtc(2) },
    ]);

    await runJob(app);
    await runJob(app);
    await runJob(app);

    const rows = await app.db.query.profits.findMany({ where: eq(profits.userId, userId) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.coinsEarned).toBe(900);
  });

  it('re-derives the whole day, self-healing a late-arriving trade recorded after the first run', async () => {
    const userId = await createVerifiedUser(app, 'rollup-late-arrival@example.com');
    await app.db.insert(trades).values([
      { id: newId(), userId, tradeId: 't-early', resourceId: 'r-early', status: 'sold', buyPrice: 100, sellPrice: 200, eaTax: 10, netProfit: 90, boughtAt: todayUtc(1), soldAt: todayUtc(2) },
    ]);
    await runJob(app);

    // A second trade for the same user/day arrives (e.g. a delayed extension batch) after the first hourly run.
    await app.db.insert(trades).values([
      { id: newId(), userId, tradeId: 't-late', resourceId: 'r-late', status: 'sold', buyPrice: 300, sellPrice: 700, eaTax: 35, netProfit: 365, boughtAt: todayUtc(5), soldAt: todayUtc(6) },
    ]);
    await runJob(app);

    const row = await app.db.query.profits.findFirst({ where: eq(profits.userId, userId) });
    expect(row!.coinsEarned).toBe(200 + 700);
    expect(row!.tradesClosed).toBe(2);
  });

  it('leaves users with no trade/sniping activity today untouched (no stray rows)', async () => {
    await createVerifiedUser(app, 'rollup-inactive@example.com');
    await runJob(app);
    const rows = await app.db.query.profits.findMany();
    expect(rows).toHaveLength(0);
  });
});
