// Materialisation: computeDailyMetrics produces the expected analytics_daily
// rows for a day with known activity, materializeDay is idempotent (running
// it twice for the same day converges to the same final rows, not
// duplicates), and the backfill script upserts every day in a range.

import { analyticsDaily, profits, users } from '@sl/db';
import { closeTestDb, createTestDb, resetDatabase } from '@sl/db/test-utils';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import { runBackfill } from '../backfill.js';
import { computeDailyMetrics, materializeDay } from '../materialize.js';

const { db, sql } = createTestDb();

async function createUser(email: string, createdAt?: Date): Promise<string> {
  const id = newId();
  await db.insert(users).values({
    id,
    email,
    passwordHash: 'x',
    emailVerifiedAt: new Date(),
    ...(createdAt ? { createdAt } : {}),
  });
  return id;
}

async function metricValue(day: string, metric: string, dimension = ''): Promise<number | null> {
  const row = await db.query.analyticsDaily.findFirst({
    where: and(
      eq(analyticsDaily.day, day),
      eq(analyticsDaily.metric, metric),
      eq(analyticsDaily.dimension, dimension),
    ),
  });
  return row ? Number(row.value) : null;
}

describe('lib/analytics/materialize', () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it("computeDailyMetrics: produces new_users and profit metrics matching the day's fixtures", async () => {
    const day = '2024-09-10';
    await createUser('materialize-new-user@example.com', new Date(`${day}T05:00:00Z`));

    const u2 = await createUser('materialize-trader@example.com', new Date('2024-01-01T00:00:00Z'));
    await db.insert(profits).values({
      id: newId(),
      userId: u2,
      day,
      netProfit: 500,
      coinsSpent: 100,
      coinsEarned: 700,
      snipes: 4,
      successes: 2,
      tradesClosed: 2,
    });

    const rows = await computeDailyMetrics(db, day);
    const byMetric = new Map(
      rows.filter((r) => r.dimension === '').map((r) => [r.metric, r.value]),
    );

    expect(byMetric.get('new_users')).toBe(1);
    expect(byMetric.get('net_profit_cents')).toBe(500);
    expect(byMetric.get('coins_spent')).toBe(100);
    expect(byMetric.get('coins_earned')).toBe(700);
    expect(byMetric.get('coins_traded')).toBe(800);
    expect(byMetric.get('snipes')).toBe(4);
    expect(byMetric.get('snipe_successes')).toBe(2);
    expect(byMetric.get('trades_closed')).toBe(2);
  });

  it('materializeDay: upserts on (day, metric, dimension) — running twice with unchanged data yields identical rows, not duplicates', async () => {
    const day = '2024-09-11';
    const u = await createUser(
      'materialize-idempotent@example.com',
      new Date('2024-01-01T00:00:00Z'),
    );
    await db.insert(profits).values({
      id: newId(),
      userId: u,
      day,
      netProfit: 250,
      coinsSpent: 50,
      coinsEarned: 350,
      snipes: 2,
      successes: 1,
      tradesClosed: 1,
    });

    const firstRowCount = await materializeDay(db, day);
    const afterFirst = await db.query.analyticsDaily.findMany({
      where: eq(analyticsDaily.day, day),
    });
    expect(afterFirst.length).toBe(firstRowCount);

    const secondRowCount = await materializeDay(db, day);
    const afterSecond = await db.query.analyticsDaily.findMany({
      where: eq(analyticsDaily.day, day),
    });

    expect(secondRowCount).toBe(firstRowCount);
    expect(afterSecond.length).toBe(afterFirst.length); // no duplicate rows
    expect(await metricValue(day, 'net_profit_cents')).toBe(250);

    // Now change the underlying data and re-materialize: the same row
    // should be overwritten (upsert), not a second row appended.
    await db
      .update(profits)
      .set({ netProfit: 999 })
      .where(and(eq(profits.userId, u), eq(profits.day, day)));
    await materializeDay(db, day);
    const afterUpdate = await db.query.analyticsDaily.findMany({
      where: and(
        eq(analyticsDaily.day, day),
        eq(analyticsDaily.metric, 'net_profit_cents'),
        eq(analyticsDaily.dimension, ''),
      ),
    });
    expect(afterUpdate).toHaveLength(1);
    expect(Number(afterUpdate[0]!.value)).toBe(999);
  });

  it('runBackfill: materializes every day in [from, to] and refreshes mv_kpi_daily without throwing', async () => {
    const u = await createUser('backfill-user@example.com', new Date('2024-01-01T00:00:00Z'));
    await db.insert(profits).values([
      { id: newId(), userId: u, day: '2024-09-01', netProfit: 10, coinsSpent: 1, coinsEarned: 11 },
      { id: newId(), userId: u, day: '2024-09-02', netProfit: 20, coinsSpent: 2, coinsEarned: 22 },
      { id: newId(), userId: u, day: '2024-09-03', netProfit: 30, coinsSpent: 3, coinsEarned: 33 },
    ]);

    const result = await runBackfill('2024-09-01', '2024-09-03');
    expect(result.days).toBe(3);
    expect(result.rows).toBeGreaterThan(0);

    expect(await metricValue('2024-09-01', 'net_profit_cents')).toBe(10);
    expect(await metricValue('2024-09-02', 'net_profit_cents')).toBe(20);
    expect(await metricValue('2024-09-03', 'net_profit_cents')).toBe(30);

    // Re-running the same backfill range is idempotent: same values, no
    // duplicate rows.
    const secondResult = await runBackfill('2024-09-01', '2024-09-03');
    expect(secondResult.rows).toBe(result.rows);
    expect(await metricValue('2024-09-02', 'net_profit_cents')).toBe(20);
  });
});
