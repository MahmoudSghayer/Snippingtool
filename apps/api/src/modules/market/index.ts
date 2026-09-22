// /api/v1/market — what is trading, what moved, and one card's observed
// price history (docs/14-ml-suggestions.md Phase B).
//
// Phase B has no models in it. Every number here is an aggregate over
// observed listings the extension already reports into `sniping_activity`
// (`listed_price`, `outcome`, `occurred_at`, keyed by `resource_id`), which
// makes this useful on day one and generates the history the later phases
// need. Phase A's `price_observations` is not read yet: it is still empty,
// because the third-party sources that would fill it decline automated
// access (see lib/collectors/sources/index.ts).
//
// Three deliberate choices, because each looks like over-engineering until
// it is needed:
//
//   1. `resource_id`, not `card_id`, is the join key. First-party
//      observations arrive for cards no collector has ever described, so
//      requiring a `cards` row would silently drop exactly the data we do
//      have. `cards` is LEFT JOINed for display only.
//   2. Empty results carry a reason. "No rows" is ambiguous between a quiet
//      market, no contributors, and a privacy suppression — and "the market
//      is quiet" is precisely how a broken pipeline reads (docs/14 §14).
//   3. Every aggregate expression below is a `sql.raw()` over a *constant*
//      string, and every runtime value reaches Postgres through the query
//      builder as a bound parameter. That is this repo's house rule
//      (packages/config/eslint-preset.js): no interpolation into a `sql`
//      template at all, so no reader has to judge which interpolation was
//      safe. Column names are fully qualified because `resource_id` exists
//      on both joined tables.

import { cards, snipingActivity } from '@sl/db';
import {
  marketActivityResponseSchema,
  marketCardHistoryQuerySchema,
  marketCardHistoryResponseSchema,
  marketMoversResponseSchema,
  marketQuerySchema,
  MARKET_WINDOW_HOURS,
  type MarketScope,
  type MarketWindow,
} from '@sl/shared';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { z } from 'zod';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * Minimum distinct contributors before a pooled aggregate is shown.
 *
 * docs/14 §12: a market price stops being personal data once stripped of
 * who observed it, but a thin slice re-identifies its contributor — an
 * observation on an obscure card at an odd hour is traceable to whoever was
 * searching for it. Three is the smallest value at which a row is not
 * trivially attributable.
 */
export const MIN_CONTRIBUTORS = 3;

/**
 * A move computed from a single observation either side is noise wearing a
 * percentage sign, so a card needs at least this many priced observations in
 * *both* windows before it can be called a mover.
 */
export const MIN_SAMPLES_PER_WINDOW = 2;

// --- Constant aggregate expressions ----------------------------------------
// `percentile_cont` rather than avg: the median resists the single mispriced
// listing a mean would happily follow, which matters when the input is
// prices observed in the wild rather than clean data.

const AGG = {
  attempts: sql.raw('count(*)::int'),
  successes: sql.raw("count(*) filter (where sniping_activity.outcome = 'success')::int"),
  contributors: sql.raw('count(distinct sniping_activity.user_id)::int'),
  medianListed: sql.raw(
    '(percentile_cont(0.5) within group (order by sniping_activity.listed_price))::int',
  ),
  minListed: sql.raw('min(sniping_activity.listed_price)::int'),
  maxListed: sql.raw('max(sniping_activity.listed_price)::int'),
  lastSeen: sql.raw('max(sniping_activity.occurred_at)'),
  pricedSamples: sql.raw('count(*) filter (where sniping_activity.listed_price is not null)::int'),
  byAttemptsDesc: sql.raw('count(*) desc'),
  // date_trunc's first argument must be a literal, and the window→bucket
  // choice is a closed set, so these are two fixed expressions rather than
  // one parameterised one.
  bucketHour: sql.raw("date_trunc('hour', sniping_activity.occurred_at)"),
  bucketDay: sql.raw("date_trunc('day', sniping_activity.occurred_at)"),
} as const;

function windowStart(window: MarketWindow, now = new Date()): Date {
  return new Date(now.getTime() - MARKET_WINDOW_HOURS[window] * 3600_000);
}

/** The equal-length period immediately before the window, for `movers`. */
function previousWindowStart(window: MarketWindow, now = new Date()): Date {
  return new Date(now.getTime() - 2 * MARKET_WINDOW_HOURS[window] * 3600_000);
}

interface WindowAggregateRow {
  resourceId: string;
  name: string | null;
  rating: number | null;
  medianListedPrice: number | null;
  samples: number;
  contributors: number;
}

export default fp(
  async function marketModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    /** Median listed price + sample counts per resource id over one bounded
     * period. Used twice by `movers` — once per window — rather than as one
     * conditional-aggregate query, because the bounds are runtime values and
     * must be bound parameters, not interpolated text. */
    async function aggregateWindow(
      from: Date,
      to: Date,
      userId: string | null,
    ): Promise<WindowAggregateRow[]> {
      return fastify.db
        .select({
          resourceId: snipingActivity.resourceId,
          name: cards.name,
          rating: cards.rating,
          medianListedPrice: AGG.medianListed as unknown as never,
          samples: AGG.pricedSamples as unknown as never,
          contributors: AGG.contributors as unknown as never,
        })
        .from(snipingActivity)
        .leftJoin(cards, eq(cards.resourceId, snipingActivity.resourceId))
        .where(
          and(
            gte(snipingActivity.occurredAt, from),
            lt(snipingActivity.occurredAt, to),
            userId ? eq(snipingActivity.userId, userId) : undefined,
          ),
        )
        .groupBy(snipingActivity.resourceId, cards.name, cards.rating) as Promise<
        WindowAggregateRow[]
      >;
    }

    app.get(
      '/api/v1/market/activity',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['market'],
          querystring: marketQuerySchema,
          response: { 200: marketActivityResponseSchema },
        },
      },
      async (request) => {
        const { window, scope, limit } = request.query;
        const scopedUserId = scope === 'mine' ? request.authUser!.id : null;
        const since = windowStart(window);

        const rows = (await fastify.db
          .select({
            resourceId: snipingActivity.resourceId,
            name: cards.name,
            rating: cards.rating,
            attempts: AGG.attempts as unknown as never,
            successes: AGG.successes as unknown as never,
            contributors: AGG.contributors as unknown as never,
            medianListedPrice: AGG.medianListed as unknown as never,
            minListedPrice: AGG.minListed as unknown as never,
            maxListedPrice: AGG.maxListed as unknown as never,
            lastSeenAt: AGG.lastSeen as unknown as never,
          })
          .from(snipingActivity)
          .leftJoin(cards, eq(cards.resourceId, snipingActivity.resourceId))
          .where(
            and(
              gte(snipingActivity.occurredAt, since),
              scopedUserId ? eq(snipingActivity.userId, scopedUserId) : undefined,
            ),
          )
          .groupBy(snipingActivity.resourceId, cards.name, cards.rating)
          .orderBy(AGG.byAttemptsDesc)
          .limit(limit)) as unknown as {
          resourceId: string;
          name: string | null;
          rating: number | null;
          attempts: number;
          successes: number;
          contributors: number;
          medianListedPrice: number | null;
          minListedPrice: number | null;
          maxListedPrice: number | null;
          lastSeenAt: Date;
        }[];

        // The threshold applies per row, not to the response: a busy card can
        // be safely poolable while a thin one beside it is not.
        const visible =
          scope === 'market' ? rows.filter((r) => r.contributors >= MIN_CONTRIBUTORS) : rows;
        const suppressed = rows.length - visible.length;

        return {
          meta: {
            scope,
            window,
            contributors:
              scope === 'market' ? rows.reduce((m, r) => Math.max(m, r.contributors), 0) : null,
            suppressedForPrivacy: suppressed > 0,
            emptyReason: emptyReasonFor(scope, visible.length, suppressed),
          },
          rows: visible.map((r) => ({
            resourceId: r.resourceId,
            name: r.name,
            rating: r.rating,
            attempts: r.attempts,
            successes: r.successes,
            successRate: r.attempts > 0 ? r.successes / r.attempts : null,
            medianListedPrice: r.medianListedPrice,
            minListedPrice: r.minListedPrice,
            maxListedPrice: r.maxListedPrice,
            lastSeenAt: new Date(r.lastSeenAt).toISOString(),
          })),
        };
      },
    );

    app.get(
      '/api/v1/market/movers',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['market'],
          querystring: marketQuerySchema,
          response: { 200: marketMoversResponseSchema },
        },
      },
      async (request) => {
        const { window, scope, limit } = request.query;
        const scopedUserId = scope === 'mine' ? request.authUser!.id : null;
        const now = new Date();
        const since = windowStart(window, now);
        const previousSince = previousWindowStart(window, now);

        const [current, previous] = await Promise.all([
          aggregateWindow(since, now, scopedUserId),
          aggregateWindow(previousSince, since, scopedUserId),
        ]);

        const previousByResource = new Map(previous.map((r) => [r.resourceId, r]));

        let suppressed = 0;
        const moved = current
          .flatMap((cur) => {
            const prev = previousByResource.get(cur.resourceId);
            if (!prev) return [];
            if (cur.medianListedPrice == null || prev.medianListedPrice == null) return [];
            if (prev.medianListedPrice <= 0) return [];
            if (cur.samples < MIN_SAMPLES_PER_WINDOW || prev.samples < MIN_SAMPLES_PER_WINDOW) {
              return [];
            }
            if (scope === 'market') {
              // Both halves of the comparison must clear the threshold —
              // a pooled "current" against a single-contributor "previous"
              // still exposes that one contributor's observation.
              const worst = Math.min(cur.contributors, prev.contributors);
              if (worst < MIN_CONTRIBUTORS) {
                suppressed += 1;
                return [];
              }
            }
            return [
              {
                resourceId: cur.resourceId,
                name: cur.name,
                rating: cur.rating,
                currentMedian: cur.medianListedPrice,
                previousMedian: prev.medianListedPrice,
                changePct:
                  ((cur.medianListedPrice - prev.medianListedPrice) / prev.medianListedPrice) * 100,
                currentSamples: cur.samples,
                previousSamples: prev.samples,
              },
            ];
          })
          .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
          .slice(0, limit);

        return {
          meta: {
            scope,
            window,
            contributors:
              scope === 'market' ? current.reduce((m, r) => Math.max(m, r.contributors), 0) : null,
            suppressedForPrivacy: suppressed > 0,
            emptyReason:
              moved.length > 0
                ? null
                : suppressed > 0
                  ? `every candidate so far comes from fewer than ${MIN_CONTRIBUTORS} people, so it is withheld`
                  : 'not enough observed prices on both sides of this window to compare',
          },
          rows: moved,
        };
      },
    );

    app.get(
      '/api/v1/market/cards/:resourceId',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['market'],
          params: z.object({ resourceId: z.string().min(1).max(64) }),
          querystring: marketCardHistoryQuerySchema,
          response: { 200: marketCardHistoryResponseSchema },
        },
      },
      async (request) => {
        const { window, scope } = request.query;
        const { resourceId } = request.params;
        const scopedUserId = scope === 'mine' ? request.authUser!.id : null;
        const since = windowStart(window);

        // Bucket width follows the window so a chart has a usable number of
        // points either way: hourly up to a week, daily beyond it.
        const bucket = MARKET_WINDOW_HOURS[window] > 24 * 7 ? AGG.bucketDay : AGG.bucketHour;

        const [card] = await fastify.db
          .select({ name: cards.name, rating: cards.rating })
          .from(cards)
          .where(eq(cards.resourceId, resourceId))
          .limit(1);

        const points = (await fastify.db
          .select({
            bucket: bucket as unknown as never,
            medianListedPrice: AGG.medianListed as unknown as never,
            samples: AGG.pricedSamples as unknown as never,
            contributors: AGG.contributors as unknown as never,
          })
          .from(snipingActivity)
          .where(
            and(
              eq(snipingActivity.resourceId, resourceId),
              gte(snipingActivity.occurredAt, since),
              scopedUserId ? eq(snipingActivity.userId, scopedUserId) : undefined,
            ),
          )
          .groupBy(bucket)
          .orderBy(bucket)) as unknown as {
          bucket: Date;
          medianListedPrice: number | null;
          samples: number;
          contributors: number;
        }[];

        const visible = points.filter(
          (p) =>
            p.medianListedPrice != null &&
            p.samples > 0 &&
            (scope === 'mine' || p.contributors >= MIN_CONTRIBUTORS),
        );

        return {
          meta: {
            scope,
            window,
            contributors:
              scope === 'market' ? points.reduce((m, p) => Math.max(m, p.contributors), 0) : null,
            suppressedForPrivacy: scope === 'market' && visible.length < points.length,
            emptyReason:
              visible.length > 0 ? null : 'no observed prices for this card in this window',
          },
          resourceId,
          name: card?.name ?? null,
          rating: card?.rating ?? null,
          points: visible.map((p) => ({
            bucket: new Date(p.bucket).toISOString(),
            medianListedPrice: p.medianListedPrice!,
            samples: p.samples,
          })),
        };
      },
    );
  },
  { name: 'market', dependencies: ['config', 'db', 'auth'] },
);

function emptyReasonFor(scope: MarketScope, visible: number, suppressed: number): string | null {
  if (visible > 0) return null;
  if (suppressed > 0) {
    return `every result so far comes from fewer than ${MIN_CONTRIBUTORS} people, so it is withheld`;
  }
  return scope === 'market'
    ? 'no pooled observations in this window yet'
    : 'no snipe attempts of your own in this window yet';
}
