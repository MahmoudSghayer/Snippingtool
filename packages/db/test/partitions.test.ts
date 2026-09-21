import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { users, userActivity } from '../src/schema/index';
import { createTestDb, closeTestDb, resetDatabase } from '../src/test-utils';

describe('partition routing on user_activity', () => {
  const { db, sql: client } = createTestDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(client);
  });

  it('routes a row to the partition matching its occurred_at month', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'partition-test@example.com', passwordHash: 'x' })
      .returning();
    const now = new Date();

    await db.insert(userActivity).values({ userId: user!.id, type: 'login', occurredAt: now });

    const [row] = await db
      .select({ partition: sql<string>`tableoid::regclass::text` })
      .from(userActivity)
      .where(eq(userActivity.userId, user!.id));
    const expectedSuffix = `_y${now.getUTCFullYear()}m${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(row).toBeDefined();
    expect(row!.partition).toBe(`user_activity${expectedSuffix}`);
  });

  it('routes a row with an out-of-range occurred_at to the default partition', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'partition-default@example.com', passwordHash: 'x' })
      .returning();
    const farFuture = new Date('2099-01-15T00:00:00Z');

    await db
      .insert(userActivity)
      .values({ userId: user!.id, type: 'login', occurredAt: farFuture });

    const [row] = await db
      .select({ partition: sql<string>`tableoid::regclass::text` })
      .from(userActivity)
      .where(eq(userActivity.userId, user!.id));
    expect(row!.partition).toBe('user_activity_default');
  });
});
