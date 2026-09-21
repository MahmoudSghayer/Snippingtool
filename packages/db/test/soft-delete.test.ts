import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { users } from '../src/schema/index';
import { createTestDb, closeTestDb, resetDatabase } from '../src/test-utils';

describe('partial unique index on users.email (soft-delete aware)', () => {
  const { db, sql } = createTestDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('rejects a second live user with the same email', async () => {
    await db.insert(users).values({ email: 'dupe@example.com', passwordHash: 'x' });
    // drizzle-orm 0.45 wraps the driver error in a `DrizzleQueryError` whose
    // own `.message` is the failed SQL text, not the Postgres error — the
    // original `postgres` error (with the "duplicate key"/constraint-name
    // message this test cares about) is preserved on `.cause` instead.
    await expect(db.insert(users).values({ email: 'dupe@example.com', passwordHash: 'y' })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/duplicate key|unique constraint/i) },
    });
  });

  it('allows a new user to reuse an email once the original is soft-deleted', async () => {
    const [first] = await db.insert(users).values({ email: 'reuse@example.com', passwordHash: 'x' }).returning();
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, first!.id));

    const [second] = await db.insert(users).values({ email: 'reuse@example.com', passwordHash: 'y' }).returning();
    expect(second).toBeDefined();
    expect(second!.deletedAt).toBeNull();

    const rows = await db.select().from(users).where(eq(users.email, 'reuse@example.com'));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(1);
  });

  it('still rejects a third live user once one live + one soft-deleted row exist for the email', async () => {
    const [first] = await db.insert(users).values({ email: 'triple@example.com', passwordHash: 'x' }).returning();
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, first!.id));
    await db.insert(users).values({ email: 'triple@example.com', passwordHash: 'y' });

    await expect(db.insert(users).values({ email: 'triple@example.com', passwordHash: 'z' })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/duplicate key|unique constraint/i) },
    });
  });
});
