import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb, resetDatabase } from '../src/test-utils';
import { users } from '../src/schema/index';

describe('set_updated_at / bump_row_version triggers', () => {
  const { db, sql } = createTestDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('bumps updated_at and row_version on UPDATE', async () => {
    const [inserted] = await db
      .insert(users)
      .values({ email: 'trigger-test@example.com', passwordHash: 'x' })
      .returning();
    expect(inserted).toBeDefined();
    expect(inserted!.rowVersion).toBe(0);
    const originalUpdatedAt = inserted!.updatedAt;

    // Ensure a measurable time delta.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await db.update(users).set({ timezone: 'America/New_York' }).where(eq(users.id, inserted!.id));

    const [after] = await db.select().from(users).where(eq(users.id, inserted!.id));
    expect(after).toBeDefined();
    expect(after!.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    expect(after!.rowVersion).toBe(1);

    // A second update bumps it again.
    await db.update(users).set({ timezone: 'UTC' }).where(eq(users.id, inserted!.id));
    const [afterTwo] = await db.select().from(users).where(eq(users.id, inserted!.id));
    expect(afterTwo!.rowVersion).toBe(2);
  });
});
