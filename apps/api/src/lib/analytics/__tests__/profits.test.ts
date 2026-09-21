// Profit analytics: day/week/month/lifetime grouping with zero-fill, the
// leaderboard's top/least ordering, and lifetime summary math — every
// expected number is hand-computed in the comments.

import { profits, users } from '@sl/db';
import { closeTestDb, createTestDb, resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import {
  getPlatformLifetimeSummary,
  getPlatformProfitSeries,
  getProfitLeaderboard,
  getUserLifetimeProfit,
  getUserProfitSeries,
} from '../profits.js';

const { db, sql } = createTestDb();

async function createUser(email: string): Promise<string> {
  const id = newId();
  await db.insert(users).values({ id, email, passwordHash: 'x', emailVerifiedAt: new Date() });
  return id;
}

async function insertProfit(
  userId: string,
  day: string,
  values: Partial<{
    coinsSpent: number;
    coinsEarned: number;
    netProfit: number;
    snipes: number;
    successes: number;
    tradesClosed: number;
  }>,
) {
  await db.insert(profits).values({
    id: newId(),
    userId,
    day,
    coinsSpent: values.coinsSpent ?? 0,
    coinsEarned: values.coinsEarned ?? 0,
    netProfit: values.netProfit ?? 0,
    snipes: values.snipes ?? 0,
    successes: values.successes ?? 0,
    tradesClosed: values.tradesClosed ?? 0,
  });
}

describe('lib/analytics/profits', () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('getPlatformProfitSeries: day granularity is one bucket per calendar day, zero-filled for days with no rows', async () => {
    const u1 = await createUser('profits-day-1@example.com');
    const u2 = await createUser('profits-day-2@example.com');

    await insertProfit(u1, '2024-06-01', {
      netProfit: 1000,
      coinsSpent: 500,
      coinsEarned: 1600,
      snipes: 4,
      successes: 2,
      tradesClosed: 2,
    });
    await insertProfit(u2, '2024-06-01', {
      netProfit: 200,
      coinsSpent: 100,
      coinsEarned: 320,
      snipes: 1,
      successes: 1,
      tradesClosed: 1,
    });
    // 2024-06-02 has no rows at all -> must appear zero-filled.
    await insertProfit(u1, '2024-06-03', {
      netProfit: -50,
      coinsSpent: 400,
      coinsEarned: 360,
      snipes: 3,
      successes: 0,
      tradesClosed: 1,
    });

    const items = await getPlatformProfitSeries(db, {
      from: '2024-06-01',
      to: '2024-06-03',
      granularity: 'day',
    });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.bucket)).toEqual(['2024-06-01', '2024-06-02', '2024-06-03']);

    expect(items[0]).toMatchObject({
      netProfit: 1200,
      coinsSpent: 600,
      coinsEarned: 1920,
      coinsTraded: 2520,
      snipes: 5,
      successes: 3,
      tradesClosed: 3,
      activeTraders: 2,
    });
    expect(items[0]!.snipeSuccessRate).toBeCloseTo(3 / 5, 10);

    expect(items[1]).toMatchObject({
      netProfit: 0,
      coinsSpent: 0,
      coinsEarned: 0,
      coinsTraded: 0,
      snipes: 0,
      successes: 0,
      tradesClosed: 0,
      activeTraders: 0,
      snipeSuccessRate: 0,
    });

    expect(items[2]).toMatchObject({
      netProfit: -50,
      coinsSpent: 400,
      coinsEarned: 360,
      coinsTraded: 760,
      snipes: 3,
      successes: 0,
      tradesClosed: 1,
      activeTraders: 1,
      snipeSuccessRate: 0,
    });
  });

  it('getPlatformProfitSeries: week granularity buckets by Monday-anchored ISO week', async () => {
    const u1 = await createUser('profits-week-1@example.com');
    // 2024-01-01 is a Monday; 2024-01-03 is in the same week; 2024-01-08 is the next Monday.
    await insertProfit(u1, '2024-01-01', { netProfit: 100 });
    await insertProfit(u1, '2024-01-03', { netProfit: 50 });
    await insertProfit(u1, '2024-01-08', { netProfit: 25 });

    const items = await getPlatformProfitSeries(db, {
      from: '2024-01-01',
      to: '2024-01-08',
      granularity: 'week',
    });
    expect(items.map((i) => i.bucket)).toEqual(['2024-01-01', '2024-01-08']);
    expect(items[0]!.netProfit).toBe(150); // Jan 1 + Jan 3
    expect(items[1]!.netProfit).toBe(25); // Jan 8
  });

  it('getPlatformProfitSeries: month granularity buckets by first-of-month', async () => {
    const u1 = await createUser('profits-month-1@example.com');
    await insertProfit(u1, '2024-02-01', { netProfit: 10 });
    await insertProfit(u1, '2024-02-28', { netProfit: 20 });
    await insertProfit(u1, '2024-03-01', { netProfit: 5 });

    const items = await getPlatformProfitSeries(db, {
      from: '2024-02-01',
      to: '2024-03-01',
      granularity: 'month',
    });
    expect(items.map((i) => i.bucket)).toEqual(['2024-02-01', '2024-03-01']);
    expect(items[0]!.netProfit).toBe(30);
    expect(items[1]!.netProfit).toBe(5);
  });

  it('getPlatformProfitSeries: lifetime granularity collapses the whole range into one bucket', async () => {
    const u1 = await createUser('profits-lifetime-1@example.com');
    await insertProfit(u1, '2024-01-01', { netProfit: 10 });
    await insertProfit(u1, '2024-06-15', { netProfit: 20 });
    await insertProfit(u1, '2024-12-31', { netProfit: 30 });

    const items = await getPlatformProfitSeries(db, {
      from: '2024-01-01',
      to: '2024-12-31',
      granularity: 'lifetime',
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.bucket).toBe('lifetime');
    expect(items[0]!.netProfit).toBe(60);
  });

  it('getUserProfitSeries: scoped to one user only', async () => {
    const u1 = await createUser('profits-scoped-1@example.com');
    const u2 = await createUser('profits-scoped-2@example.com');
    await insertProfit(u1, '2024-04-01', { netProfit: 100 });
    await insertProfit(u2, '2024-04-01', { netProfit: 999 });

    const items = await getUserProfitSeries(db, u1, {
      from: '2024-04-01',
      to: '2024-04-01',
      granularity: 'day',
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.netProfit).toBe(100);
  });

  it('getUserLifetimeProfit / getPlatformLifetimeSummary: all-time totals and average per active trader', async () => {
    const u1 = await createUser('profits-lifetime-summary-1@example.com');
    const u2 = await createUser('profits-lifetime-summary-2@example.com');
    await insertProfit(u1, '2024-07-01', { netProfit: 300, coinsSpent: 100, coinsEarned: 500 });
    await insertProfit(u1, '2024-07-02', { netProfit: 100, coinsSpent: 50, coinsEarned: 200 });
    await insertProfit(u2, '2024-07-01', { netProfit: -100, coinsSpent: 200, coinsEarned: 50 });

    const u1Lifetime = await getUserLifetimeProfit(db, u1);
    expect(u1Lifetime.netProfit).toBe(400);
    expect(u1Lifetime.coinsSpent).toBe(150);
    expect(u1Lifetime.coinsEarned).toBe(700);

    const platform = await getPlatformLifetimeSummary(db, { from: '2024-07-01', to: '2024-07-02' });
    expect(platform.netProfit).toBe(300); // 400 (u1) + -100 (u2)
    expect(platform.coinsTraded).toBe(150 + 700 + 200 + 50); // 1100
    expect(platform.avgProfitPerActiveTrader).toBeCloseTo(300 / 2, 10); // 2 distinct traders
  });

  it('getProfitLeaderboard: top-N descending and least-N ascending by summed net profit, ties broken by userId', async () => {
    const uHigh = await createUser('leaderboard-high@example.com');
    const uMid = await createUser('leaderboard-mid@example.com');
    const uLow = await createUser('leaderboard-low@example.com');

    await insertProfit(uHigh, '2024-08-01', {
      netProfit: 1000,
      coinsSpent: 200,
      coinsEarned: 1200,
    });
    await insertProfit(uMid, '2024-08-01', { netProfit: 500, coinsSpent: 100, coinsEarned: 600 });
    await insertProfit(uLow, '2024-08-01', { netProfit: -200, coinsSpent: 300, coinsEarned: 100 });

    const top = await getProfitLeaderboard(db, {
      from: '2024-08-01',
      to: '2024-08-01',
      limit: 2,
      order: 'top',
    });
    expect(top).toHaveLength(2);
    expect(top[0]).toMatchObject({ rank: 1, userId: uHigh, netProfit: 1000, coinsTraded: 1400 });
    expect(top[1]).toMatchObject({ rank: 2, userId: uMid, netProfit: 500, coinsTraded: 700 });

    const least = await getProfitLeaderboard(db, {
      from: '2024-08-01',
      to: '2024-08-01',
      limit: 2,
      order: 'least',
    });
    expect(least).toHaveLength(2);
    expect(least[0]).toMatchObject({ rank: 1, userId: uLow, netProfit: -200, coinsTraded: 400 });
    expect(least[1]).toMatchObject({ rank: 2, userId: uMid, netProfit: 500 });
  });
});
