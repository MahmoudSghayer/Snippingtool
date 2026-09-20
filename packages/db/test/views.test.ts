import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, closeTestDb, resetDatabase } from '../src/test-utils';
import { plans, subscriptions, users } from '../src/schema/index';
import { vMrr, vArr } from '../src/schema/system';

describe('v_mrr / v_arr', () => {
  const { db, sql } = createTestDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('sums only active, non-lifetime subscriptions, normalised to monthly', async () => {
    const [monthlyPlan] = await db
      .insert(plans)
      .values({ code: 'mrr-monthly', name: 'Monthly', priceCents: 1000, interval: 'month', deviceLimit: 1 })
      .returning();
    const [yearlyPlan] = await db
      .insert(plans)
      .values({ code: 'mrr-yearly', name: 'Yearly', priceCents: 12000, interval: 'year', deviceLimit: 1 })
      .returning();
    const [lifetimePlan] = await db
      .insert(plans)
      .values({ code: 'mrr-lifetime', name: 'Lifetime', priceCents: 99999, interval: 'one_time', isLifetime: true, deviceLimit: 3 })
      .returning();
    const [trialingPlan] = await db
      .insert(plans)
      .values({ code: 'mrr-trialing-plan', name: 'Trialing', priceCents: 5000, interval: 'month', deviceLimit: 1 })
      .returning();

    const userRows = await db
      .insert(users)
      .values([
        { email: 'mrr-1@example.com', passwordHash: 'x' },
        { email: 'mrr-2@example.com', passwordHash: 'x' },
        { email: 'mrr-3@example.com', passwordHash: 'x' },
        { email: 'mrr-4@example.com', passwordHash: 'x' },
      ])
      .returning();

    // Active monthly: contributes 1000 cents flat.
    await db.insert(subscriptions).values({
      userId: userRows[0]!.id,
      planId: monthlyPlan!.id,
      status: 'active',
      source: 'manual',
    });
    // Active yearly: contributes 12000 / 12 = 1000 cents.
    await db.insert(subscriptions).values({
      userId: userRows[1]!.id,
      planId: yearlyPlan!.id,
      status: 'active',
      source: 'manual',
    });
    // Active lifetime: excluded (is_lifetime = true).
    await db.insert(subscriptions).values({
      userId: userRows[2]!.id,
      planId: lifetimePlan!.id,
      status: 'lifetime',
      source: 'manual',
    });
    // Trialing: excluded (status != active).
    await db.insert(subscriptions).values({
      userId: userRows[3]!.id,
      planId: trialingPlan!.id,
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      source: 'manual',
    });

    const [mrr] = await db.select().from(vMrr);
    expect(mrr).toBeDefined();
    expect(Number(mrr!.mrrCents)).toBeCloseTo(2000, 5);

    const [arr] = await db.select().from(vArr);
    expect(Number(arr!.arrCents)).toBeCloseTo(2000 * 12, 4);
  });

  it('returns 0 when there are no active non-lifetime subscriptions', async () => {
    const [mrr] = await db.select().from(vMrr);
    expect(Number(mrr!.mrrCents)).toBe(0);
  });
});
