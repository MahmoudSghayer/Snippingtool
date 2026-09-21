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

  // --- Defect #8 (docs/12-testing.md "Defects found") — FIXED by
  // migrations/0026_users_row_version_exclude_billing.sql ---
  //
  // `users` no longer uses the generic bump_row_version() trigger every
  // other row_version-bearing table still uses (asserted above via a
  // non-users update pattern implicitly — see 0001_extensions_and_helpers's
  // own coverage for the generic function); it uses
  // bump_users_row_version(), which skips the bump when the only column
  // that changed is stripe_customer_id (billing metadata a webhook writes,
  // not something the account holder's own session did — see that
  // migration's header comment for why this is an exclude-list, not an
  // allow-list).
  describe('users-specific trigger: stripe_customer_id is excluded from the row_version bump (defect #8)', () => {
    it('writing ONLY stripe_customer_id does not bump row_version', async () => {
      const [inserted] = await db
        .insert(users)
        .values({ email: 'trigger-stripe-only@example.com', passwordHash: 'x' })
        .returning();
      expect(inserted!.rowVersion).toBe(0);

      await db.update(users).set({ stripeCustomerId: 'cus_test_only_billing' }).where(eq(users.id, inserted!.id));

      const [after] = await db.select().from(users).where(eq(users.id, inserted!.id));
      expect(after!.stripeCustomerId).toBe('cus_test_only_billing');
      expect(after!.rowVersion).toBe(0); // unchanged — the whole point of the fix
    });

    it('a second, later stripe_customer_id-only write still does not bump it', async () => {
      const [inserted] = await db
        .insert(users)
        .values({ email: 'trigger-stripe-twice@example.com', passwordHash: 'x', stripeCustomerId: 'cus_test_first' })
        .returning();
      expect(inserted!.rowVersion).toBe(0);

      await db.update(users).set({ stripeCustomerId: 'cus_test_second' }).where(eq(users.id, inserted!.id));

      const [after] = await db.select().from(users).where(eq(users.id, inserted!.id));
      expect(after!.stripeCustomerId).toBe('cus_test_second');
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

    it('changing stripe_customer_id together with a security-relevant column still bumps (excluding one column does not exempt the whole write)', async () => {
      const [inserted] = await db
        .insert(users)
        .values({ email: 'trigger-stripe-plus-password@example.com', passwordHash: 'x' })
        .returning();
      expect(inserted!.rowVersion).toBe(0);

      await db.update(users).set({ stripeCustomerId: 'cus_test_combo', passwordHash: 'new-hash-combo' }).where(eq(users.id, inserted!.id));

      const [after] = await db.select().from(users).where(eq(users.id, inserted!.id));
      expect(after!.stripeCustomerId).toBe('cus_test_combo');
      expect(after!.rowVersion).toBe(1);
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
