// The per-(user, day) profit rollup runs on every trade/snipe write, so two
// requests for the same user can roll the same day up at the same moment.
// It must converge on one correct row instead of failing on the unique index.

import { profits, trades, users } from '@sl/db';
import { closeTestDb, createTestDb, resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import { rollupProfitsForUserDay } from '../rollup.js';

const { db, sql } = createTestDb();

describe('lib/analytics/rollup', () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('concurrent rollups of the same first day converge on one row', async () => {
    const userId = newId();
    await db
      .insert(users)
      .values({ id: userId, email: 'rollup-race@example.com', passwordHash: 'x' });
    const at = new Date(Date.UTC(2024, 5, 1, 12));
    await db.insert(trades).values({
      id: newId(),
      userId,
      tradeId: 't-1',
      resourceId: '1',
      buyPrice: 1000,
      sellPrice: 2000,
      eaTax: 100,
      netProfit: 900,
      status: 'sold',
      boughtAt: at,
      soldAt: at,
    });

    await Promise.all(
      Array.from({ length: 6 }, () => rollupProfitsForUserDay(db, userId, '2024-06-01')),
    );

    const rows = await db.query.profits.findMany({ where: eq(profits.userId, userId) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2024-06-01', netProfit: 900, tradesClosed: 1 });
  });

  it('a day with no activity never creates an empty row', async () => {
    const userId = newId();
    await db
      .insert(users)
      .values({ id: userId, email: 'rollup-empty@example.com', passwordHash: 'x' });

    await rollupProfitsForUserDay(db, userId, '2024-06-02');

    expect(await db.query.profits.findMany({ where: eq(profits.userId, userId) })).toEqual([]);
  });
});
