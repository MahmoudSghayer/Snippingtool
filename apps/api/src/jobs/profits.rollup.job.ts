// Hourly: recomputes today's `profits` row (upsert) for every user with
// trade or sniping activity today, from `trades` + `sniping_activity`. Runs
// hourly and re-derives the whole day each time (idempotent, converges by
// end of day) rather than incrementing, so a missed run or a late-arriving
// batch from the extension is self-healing.

import { profits, snipingActivity, trades } from '@sl/db';
import { and, eq, gte, isNull, lt } from 'drizzle-orm';

import { newId } from '../lib/ids.js';

import { defineJob } from './types.js';

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export default defineJob({
  name: 'profits.rollup',
  schedule: '7 * * * *', // hourly, offset a few minutes past the hour
  async processor(_job, { db, log }) {
    const now = new Date();
    const dayStart = startOfUtcDay(now);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const day = dayStart.toISOString().slice(0, 10);

    const soldToday = await db.query.trades.findMany({
      where: and(isNull(trades.deletedAt), gte(trades.soldAt, dayStart), lt(trades.soldAt, dayEnd)),
    });
    const boughtToday = await db.query.trades.findMany({
      where: and(
        isNull(trades.deletedAt),
        gte(trades.boughtAt, dayStart),
        lt(trades.boughtAt, dayEnd),
      ),
    });
    const snipesToday = await db.query.snipingActivity.findMany({
      where: and(gte(snipingActivity.occurredAt, dayStart), lt(snipingActivity.occurredAt, dayEnd)),
    });

    const userIds = new Set<string>([
      ...soldToday.map((t) => t.userId),
      ...boughtToday.map((t) => t.userId),
      ...snipesToday.map((s) => s.userId),
    ]);

    for (const userId of userIds) {
      const sold = soldToday.filter((t) => t.userId === userId);
      const bought = boughtToday.filter((t) => t.userId === userId);
      const snipes = snipesToday.filter((s) => s.userId === userId);

      const coinsEarned = sold.reduce((sum, t) => sum + (t.sellPrice ?? 0), 0);
      const netProfit = sold.reduce((sum, t) => sum + (t.netProfit ?? 0), 0);
      const coinsSpent = bought.reduce((sum, t) => sum + (t.buyPrice ?? 0), 0);
      const tradesClosed = sold.length;
      const snipeCount = snipes.length;
      const successes = snipes.filter((s) => s.outcome === 'success').length;

      const existing = await db.query.profits.findFirst({
        where: and(eq(profits.userId, userId), eq(profits.day, day)),
      });
      const values = {
        coinsSpent,
        coinsEarned,
        netProfit,
        snipes: snipeCount,
        successes,
        tradesClosed,
      };

      if (existing) {
        await db.update(profits).set(values).where(eq(profits.id, existing.id));
      } else {
        await db.insert(profits).values({ id: newId(), userId, day, ...values });
      }
    }

    log.info({ day, usersRolledUp: userIds.size }, 'profits.rollup complete');
  },
});
