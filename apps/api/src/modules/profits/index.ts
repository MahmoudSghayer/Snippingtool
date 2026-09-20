// GET /api/v1/profits — daily/weekly/monthly/lifetime P&L summary, read from
// the `profits` daily-rollup table (populated by the profits.rollup job).

import { profits } from '@sl/db';
import { dailyProfitSchema, profitQuerySchema, type DailyProfit } from '@sl/shared';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

function bucketKey(day: string, granularity: 'weekly' | 'monthly'): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (granularity === 'monthly') {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  // ISO week bucket: Monday of that week.
  const dow = (date.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - dow);
  return monday.toISOString().slice(0, 10);
}

function aggregate(rows: DailyProfit[], key: (row: DailyProfit) => string): DailyProfit[] {
  const buckets = new Map<string, DailyProfit>();
  for (const row of rows) {
    const k = key(row);
    const bucket = buckets.get(k) ?? { day: k, coinsSpent: 0, coinsEarned: 0, netProfit: 0, snipes: 0, successes: 0, tradesClosed: 0 };
    bucket.coinsSpent += row.coinsSpent;
    bucket.coinsEarned += row.coinsEarned;
    bucket.netProfit += row.netProfit;
    bucket.snipes += row.snipes;
    bucket.successes += row.successes;
    bucket.tradesClosed += row.tradesClosed;
    buckets.set(k, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export default fp(
  async function profitsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get(
      '/api/v1/profits',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['profits'],
          querystring: profitQuerySchema,
          response: { 200: z.object({ granularity: z.enum(['daily', 'weekly', 'monthly', 'lifetime']), items: z.array(dailyProfitSchema) }) },
        },
      },
      async (request) => {
        const { from, to, granularity } = request.query;
        const userId = request.authUser!.id;

        const rows = await fastify.db.query.profits.findMany({
          where: and(eq(profits.userId, userId), gte(profits.day, from), lte(profits.day, to)),
          orderBy: [asc(profits.day)],
        });

        const daily: DailyProfit[] = rows.map((r) => ({
          day: r.day,
          coinsSpent: r.coinsSpent,
          coinsEarned: r.coinsEarned,
          netProfit: r.netProfit,
          snipes: r.snipes,
          successes: r.successes,
          tradesClosed: r.tradesClosed,
        }));

        if (granularity === 'daily') return { granularity, items: daily };
        if (granularity === 'weekly') return { granularity, items: aggregate(daily, (r) => bucketKey(r.day, 'weekly')) };
        if (granularity === 'monthly') return { granularity, items: aggregate(daily, (r) => bucketKey(r.day, 'monthly')) };

        // lifetime: one bucket covering the whole requested range.
        const lifetime = aggregate(daily, () => 'lifetime');
        return { granularity, items: lifetime };
      },
    );
  },
  { name: 'module:profits', dependencies: ['auth', 'db'] },
);
