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

    // Each in its own transaction, as every real caller runs it, so the
    // per-(user, day) advisory lock is actually held while each computes.
    await Promise.all(
      Array.from({ length: 6 }, () =>
        db.transaction((tx) => rollupProfitsForUserDay(tx, userId, '2024-06-01')),
      ),
    );

    const rows = await db.query.profits.findMany({ where: eq(profits.userId, userId) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: '2024-06-01', netProfit: 900, tradesClosed: 1 });
  });

  it('excludes gallery trades from the profit rollup, counting snipe/bid (and untagged) only', async () => {
    const userId = newId();
    await db
      .insert(users)
      .values({ id: userId, email: 'rollup-gallery@example.com', passwordHash: 'x' });
    const at = new Date(Date.UTC(2024, 5, 4, 12));
    await db.insert(trades).values([
      // A normal snipe: bought 1000, sold 2000, +900 net. Counts.
      {
        id: newId(),
        userId,
        tradeId: 'snipe-1',
        resourceId: '10',
        buyPrice: 1000,
        sellPrice: 2000,
        eaTax: 100,
        netProfit: 900,
        status: 'sold',
        mode: 'snipe',
        boughtAt: at,
        soldAt: at,
      },
      // A gallery grind buy sold at a deliberate loss. Must NOT count.
      {
        id: newId(),
        userId,
        tradeId: 'gallery-1',
        resourceId: '11',
        buyPrice: 5000,
        sellPrice: 3000,
        eaTax: 150,
        netProfit: -2150,
        status: 'sold',
        mode: 'gallery',
        boughtAt: at,
        soldAt: at,
      },
      // A legacy untagged trade (mode null) is treated as trading -> counts.
      {
        id: newId(),
        userId,
        tradeId: 'legacy-1',
        resourceId: '12',
        buyPrice: 500,
        sellPrice: 800,
        eaTax: 40,
        netProfit: 260,
        status: 'sold',
        boughtAt: at,
        soldAt: at,
      },
    ]);

    await db.transaction((tx) => rollupProfitsForUserDay(tx, userId, '2024-06-04'));

    const [row] = await db.query.profits.findMany({ where: eq(profits.userId, userId) });
    // Only snipe + legacy: spent 1500, earned 2800, net 1160, 2 closed.
    expect(row).toMatchObject({
      day: '2024-06-04',
      coinsSpent: 1500,
      coinsEarned: 2800,
      netProfit: 1160,
      tradesClosed: 2,
    });
  });

  it('a day with no activity never creates an empty row', async () => {
    const userId = newId();
    await db
      .insert(users)
      .values({ id: userId, email: 'rollup-empty@example.com', passwordHash: 'x' });

    await db.transaction((tx) => rollupProfitsForUserDay(tx, userId, '2024-06-02'));

    expect(await db.query.profits.findMany({ where: eq(profits.userId, userId) })).toEqual([]);
  });

  // The advisory lock is transaction-scoped: outside a transaction it is
  // released as soon as it is taken and serialises nothing.
  it('refuses to run outside a transaction', async () => {
    await expect(rollupProfitsForUserDay(db as never, newId(), '2024-06-03')).rejects.toThrow(
      /transaction/,
    );
  });
});
