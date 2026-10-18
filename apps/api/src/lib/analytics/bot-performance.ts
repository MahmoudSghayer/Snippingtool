// Nova AI bot performance over a time range, for `GET /admin/bot-performance`
// (the dashboard's /admin/performance): race results and timings from
// `sniping_activity`, search pace and where the time went from the bot pace
// on `heartbeat` rows (`botPaceSchema`). The same numbers the ops
// `session-report` prints (infra/scripts/production-ops.sh, "where the time
// went before each buy" and "search pace per hour"); formulas in
// docs/08-analytics.md.
//
// Every query filters on `occurred_at` (both tables are range-partitioned on
// it, so only the partitions the range touches are read) and, for one user,
// on `user_id` (`*_user_id_idx` is `(user_id, occurred_at)`).

import { sql, type SQL } from 'drizzle-orm';

import type { Database } from '@sl/db';
import type {
  AdminBotPerformanceHour,
  AdminBotPerformanceResponse,
  BotAttemptTimings,
} from '@sl/shared';

export interface BotPerformanceParams {
  /** Both ends inclusive. */
  from: Date;
  to: Date;
  /** One user's bot; omit for every user. */
  userId?: string;
}

const HOUR_MS = 3_600_000;

// Who each timing group covers. A blocked attempt never sent a buy, so it
// carries no timing worth comparing.
const TIMING_GROUPS = {
  overall: sql`outcome <> 'blocked'`,
  won: sql`outcome = 'success'`,
  lost: sql`outcome IN ('failed', 'too_slow')`,
} as const;

const TIMING_COLUMNS = {
  search: sql`search_ms`,
  reaction: sql`reaction_ms`,
  buy: sql`latency_ms`,
} as const;

/** Start of each row's UTC hour, as epoch milliseconds. */
const HOUR_BUCKET = sql`(extract(epoch FROM date_trunc('hour', occurred_at, 'UTC')) * 1000)::bigint`;

// SQL is assembled from constant fragments, bound params and identifiers
// (`sql.join`), never by interpolating into a `sql` template: the repo's
// lint rule (packages/config/eslint-preset.js).
const median = (column: SQL, where: SQL) =>
  sql.join([
    sql`(percentile_cont(0.5) WITHIN GROUP (ORDER BY `,
    column,
    sql`) FILTER (WHERE `,
    where,
    sql`))::int`,
  ]);
const p90 = (column: SQL, where: SQL) =>
  sql.join([
    sql`(percentile_cont(0.9) WITHIN GROUP (ORDER BY `,
    column,
    sql`) FILTER (WHERE `,
    where,
    sql`))::int`,
  ]);
const countWhere = (where: SQL) => sql.join([sql`count(*) FILTER (WHERE `, where, sql`)::int`]);
const as = (expression: SQL, alias: string) =>
  sql.join([expression, sql` AS `, sql.identifier(alias)]);

type Row = Record<string, unknown>;

/** A count or sum as a number (postgres-js returns `bigint` as a string). */
function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function msOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function share(part: number, whole: number): number {
  return Math.min(1, Math.max(0, part / whole));
}

function perMinute(searches: number, windowMs: number): number | null {
  return windowMs > 0 ? (searches * 60_000) / windowMs : null;
}

export async function getBotPerformance(
  db: Database,
  params: BotPerformanceParams,
): Promise<AdminBotPerformanceResponse> {
  /** The range (the partition key) and, for one user, the user. */
  const rowFilter = () =>
    sql.join([
      sql`occurred_at >= `,
      sql.param(params.from.toISOString()),
      sql`::timestamptz AND occurred_at <= `,
      sql.param(params.to.toISOString()),
      sql`::timestamptz`,
      ...(params.userId ? [sql` AND user_id = `, sql.param(params.userId), sql`::uuid`] : []),
    ]);

  const outcomeCounts = sql`count(*)::int AS attempts,
    count(*) FILTER (WHERE outcome = 'success')::int AS won,
    count(*) FILTER (WHERE outcome IN ('failed', 'too_slow'))::int AS lost`;

  const timingColumns = Object.entries(TIMING_GROUPS).flatMap(([group, where]) => [
    as(countWhere(where), `${group}_n`),
    ...Object.entries(TIMING_COLUMNS).flatMap(([timing, column]) => [
      as(median(column, where), `${group}_${timing}_p50`),
      as(p90(column, where), `${group}_${timing}_p90`),
    ]),
  ]);

  const [totalsRows, attemptHourRows, paceHourRows] = await Promise.all([
    db.execute(
      sql.join([
        sql`SELECT `,
        outcomeCounts,
        sql`,
          count(*) FILTER (WHERE outcome = 'blocked')::int AS blocked,
          count(*) FILTER (WHERE outcome = 'error')::int AS errors,
          count(*) FILTER (WHERE outcome = 'attempted')::int AS unknown, `,
        sql.join(timingColumns, sql`, `),
        sql` FROM sniping_activity WHERE `,
        rowFilter(),
      ]),
    ),
    db.execute(
      sql.join([
        sql`SELECT `,
        as(HOUR_BUCKET, 'hour_ms'),
        sql`, `,
        outcomeCounts,
        sql`, `,
        as(median(TIMING_COLUMNS.search, TIMING_GROUPS.overall), 'search_p50'),
        sql`, `,
        as(median(TIMING_COLUMNS.reaction, TIMING_GROUPS.overall), 'reaction_p50'),
        sql`, `,
        as(median(TIMING_COLUMNS.buy, TIMING_GROUPS.overall), 'buy_p50'),
        sql` FROM sniping_activity WHERE `,
        rowFilter(),
        sql` GROUP BY 1`,
      ]),
    ),
    // Each pace report covers the `windowMs` before it, and counts toward
    // the hour it was sent in (as the session report does).
    db.execute(
      sql.join([
        sql`WITH pace AS (
          SELECT occurred_at, metadata -> 'bot' AS b
            FROM user_activity
           WHERE type = 'heartbeat' AND jsonb_typeof(metadata -> 'bot') = 'object' AND `,
        rowFilter(),
        sql`)
        SELECT `,
        as(HOUR_BUCKET, 'hour_ms'),
        sql`,
               sum((b ->> 'windowMs')::bigint) AS window_ms,
               sum((b ->> 'searches')::bigint) AS searches,
               sum((b ->> 'withResults')::bigint) AS with_results,
               sum((b ->> 'failed')::bigint) AS failed,
               sum((b ->> 'waitingMs')::bigint) AS waiting_ms,
               sum((b ->> 'backoffMs')::bigint) AS backoff_ms,
               sum((b ->> 'blockedMs')::bigint) AS blocked_ms,
               sum((b ->> 'breakMs')::bigint) AS break_ms,
               sum((b ->> 'cooldownMs')::bigint) AS cooldown_ms
          FROM pace
         GROUP BY 1`,
      ]),
    ),
  ]);

  const totals = ((totalsRows as unknown as Row[])[0] ?? {}) as Row;
  const timingsFor = (group: keyof typeof TIMING_GROUPS): BotAttemptTimings => {
    const pair = (timing: keyof typeof TIMING_COLUMNS) => ({
      p50: msOrNull(totals[`${group}_${timing}_p50`]),
      p90: msOrNull(totals[`${group}_${timing}_p90`]),
    });
    return {
      attempts: num(totals[`${group}_n`]),
      search: pair('search'),
      reaction: pair('reaction'),
      buy: pair('buy'),
    };
  };

  const attemptsByHour = new Map(
    (attemptHourRows as unknown as Row[]).map((r) => [num(r.hour_ms), r]),
  );
  const paceByHour = new Map((paceHourRows as unknown as Row[]).map((r) => [num(r.hour_ms), r]));

  const pace = {
    windowMs: 0,
    searches: 0,
    withResults: 0,
    failed: 0,
    waitingMs: 0,
    backoffMs: 0,
    blockedMs: 0,
    breakMs: 0,
    cooldownMs: 0,
  };
  for (const r of paceByHour.values()) {
    pace.windowMs += num(r.window_ms);
    pace.searches += num(r.searches);
    pace.withResults += num(r.with_results);
    pace.failed += num(r.failed);
    pace.waitingMs += num(r.waiting_ms);
    pace.backoffMs += num(r.backoff_ms);
    pace.blockedMs += num(r.blocked_ms);
    pace.breakMs += num(r.break_ms);
    pace.cooldownMs += num(r.cooldown_ms);
  }

  // Every UTC hour the range touches, zero-filled.
  const hourly: AdminBotPerformanceHour[] = [];
  const firstHour = Math.floor(params.from.getTime() / HOUR_MS) * HOUR_MS;
  const lastHour = Math.floor(params.to.getTime() / HOUR_MS) * HOUR_MS;
  for (let hour = firstHour; hour <= lastHour; hour += HOUR_MS) {
    const a = attemptsByHour.get(hour);
    const p = paceByHour.get(hour);
    const searches = num(p?.searches);
    hourly.push({
      hour: new Date(hour).toISOString(),
      searches,
      searchesPerMinute: perMinute(searches, num(p?.window_ms)),
      attempts: num(a?.attempts),
      won: num(a?.won),
      lost: num(a?.lost),
      searchP50: msOrNull(a?.search_p50),
      reactionP50: msOrNull(a?.reaction_p50),
      buyP50: msOrNull(a?.buy_p50),
    });
  }

  const won = num(totals.won);
  const lost = num(totals.lost);
  const waits = {
    delay: pace.waitingMs,
    backoff: pace.backoffMs,
    limit: pace.blockedMs,
    break: pace.breakMs,
    cooldown: pace.cooldownMs,
  };
  const waited = Object.values(waits).reduce((a, b) => a + b, 0);

  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    userId: params.userId ?? null,
    summary: {
      attempts: num(totals.attempts),
      won,
      lost,
      blocked: num(totals.blocked),
      errors: num(totals.errors),
      unknown: num(totals.unknown),
      winRate: won + lost > 0 ? won / (won + lost) : null,
      searches: pace.searches,
      searchesWithResults: pace.withResults,
      failedSearches: pace.failed,
      searchesPerMinute: perMinute(pace.searches, pace.windowMs),
      runningMs: pace.windowMs,
    },
    timings: {
      overall: timingsFor('overall'),
      won: timingsFor('won'),
      lost: timingsFor('lost'),
    },
    timeSplit:
      pace.windowMs > 0
        ? {
            delay: share(waits.delay, pace.windowMs),
            backoff: share(waits.backoff, pace.windowMs),
            limit: share(waits.limit, pace.windowMs),
            break: share(waits.break, pace.windowMs),
            cooldown: share(waits.cooldown, pace.windowMs),
            other: share(pace.windowMs - waited, pace.windowMs),
          }
        : null,
    hourly,
  };
}
