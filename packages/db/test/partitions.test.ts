import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb, resetDatabase } from '../src/test-utils';
import { users, userActivity } from '../src/schema/index';

describe('partition routing on user_activity', () => {
  const { db, sql } = createTestDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('routes a row to the partition matching its occurred_at month', async () => {
    const [user] = await db.insert(users).values({ email: 'partition-test@example.com', passwordHash: 'x' }).returning();
    const now = new Date();

    await db.insert(userActivity).values({ userId: user!.id, type: 'login', occurredAt: now });

    const [row] = await sql<{ partition: string }[]>`
      SELECT tableoid::regclass::text AS partition FROM user_activity WHERE user_id = ${user!.id}
    `;
    const expectedSuffix = `_y${now.getUTCFullYear()}m${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(row).toBeDefined();
    expect(row!.partition).toBe(`user_activity${expectedSuffix}`);
  });

  it('routes a row with an out-of-range occurred_at to the default partition', async () => {
    const [user] = await db.insert(users).values({ email: 'partition-default@example.com', passwordHash: 'x' }).returning();
    const farFuture = new Date('2099-01-15T00:00:00Z');

    await db.insert(userActivity).values({ userId: user!.id, type: 'login', occurredAt: farFuture });

    const [row] = await sql<{ partition: string }[]>`
      SELECT tableoid::regclass::text AS partition FROM user_activity WHERE user_id = ${user!.id}
    `;
    expect(row!.partition).toBe('user_activity_default');
  });
});
