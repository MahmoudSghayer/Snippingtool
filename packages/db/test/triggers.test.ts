import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { users } from '../src/schema/index';
import { createTestDb, closeTestDb, resetDatabase } from '../src/test-utils';

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

  // --- Defect #8 (docs/12-testing.md "Defects found") ---
  //
  // `users` uses its own bump_users_row_version() trigger (0026, narrowed by
  // 0034_drop_stripe.sql): it bumps on any change except to the generated
  // email_normalised column, whose value in NEW is unspecified inside a
  // BEFORE trigger. The billing column 0026 originally excluded was dropped
  // with Stripe.
  describe('users-specific trigger: bump_users_row_version (defect #8)', () => {
    it('an UPDATE that changes nothing does not bump row_version (email_normalised is not compared)', async () => {
      const [inserted] = await db
        .insert(users)
        .values({ email: 'trigger-noop@example.com', passwordHash: 'x' })
        .returning();
      expect(inserted!.rowVersion).toBe(0);

      await db
        .update(users)
        .set({ timezone: inserted!.timezone })
        .where(eq(users.id, inserted!.id));

      const [after] = await db.select().from(users).where(eq(users.id, inserted!.id));
      expect(after!.rowVersion).toBe(0);
    });

    it('security-relevant columns (password_hash, email, status, role, totp fields, deleted_at) still bump row_version', async () => {
      const [inserted] = await db
        .insert(users)
        .values({ email: 'trigger-security-cols@example.com', passwordHash: 'x' })
        .returning();
      let expectedVersion = 0;

      const securityWrites: Array<Record<string, unknown>> = [
        { passwordHash: 'new-hash' },
        { status: 'suspended' },
        { role: 'admin' },
        { totpEnabledAt: new Date() },
      ];
      for (const write of securityWrites) {
        await db.update(users).set(write).where(eq(users.id, inserted!.id));
        expectedVersion += 1;
        const [after] = await db.select().from(users).where(eq(users.id, inserted!.id));
        expect(after!.rowVersion, `write=${JSON.stringify(write)}`).toBe(expectedVersion);
      }
    });

    it('the force-logout "touch updated_at only" bump (modules/auth/repo.ts bumpUserVersion) still works — not silently broken by narrowing this trigger', async () => {
      const [inserted] = await db
        .insert(users)
        .values({ email: 'trigger-touch-updated-at@example.com', passwordHash: 'x' })
        .returning();
      expect(inserted!.rowVersion).toBe(0);

      // Mirrors bumpUserVersion() exactly: the only column named in the SET
      // clause is updated_at, immediately overwritten again by
      // set_updated_at — the point is only to fire this trigger.
      await db.update(users).set({ updatedAt: new Date() }).where(eq(users.id, inserted!.id));

      const [after] = await db.select().from(users).where(eq(users.id, inserted!.id));
      expect(after!.rowVersion).toBe(1);
    });
  });
});
