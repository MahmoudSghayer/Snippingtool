import { z } from 'zod';

import { ingestTimestampSchema } from './ingest-bounds.js';
import { SNIPE_OUTCOMES } from './sniping.js';

/**
 * `user_activity.type` values. This is account-agnostic product telemetry —
 * never raw market data (see docs/01-architecture.md, trust boundary
 * section, and instruction 6 in the project plan: search *metadata* only,
 * filter hash + result count, never the listings themselves).
 */
export const ACTIVITY_EVENT_TYPES = [
  'login',
  'logout',
  'search',
  'filter_change',
  'settings_change',
  'error',
  'heartbeat',
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

// Mass-assignment defence (docs/09-security.md "Input validation"): every
// object below — the shared base, each event's own `metadata`, and (further
// down) the batch envelope — is `.strict()`, so an unrecognised extra key on
// an ingest event from the extension is a 400, not a silently-dropped no-op.
const baseActivityEvent = z
  .object({
    // Bounded: user_activity and search_activity are partitioned on it
    // (see ingest-bounds.ts).
    occurredAt: ingestTimestampSchema,
    deviceId: z.string().guid().optional(), // absent before device registration completes
  })
  .strict();

export const loginActivitySchema = baseActivityEvent.extend({
  type: z.literal('login'),
  metadata: z.object({ mfaUsed: z.boolean().optional() }).strict().optional(),
});

export const logoutActivitySchema = baseActivityEvent.extend({
  type: z.literal('logout'),
  metadata: z
    .object({ reason: z.enum(['user', 'forced', 'expired']).optional() })
    .strict()
    .optional(),
});

/** `filterHash` + `resultsCount` only — never the listings. See
 * `savedFilterSchema` for the filter shape this hashes. */
export const searchActivitySchema = baseActivityEvent.extend({
  type: z.literal('search'),
  metadata: z
    .object({
      filterHash: z.string().min(1).max(128),
      resourceId: z.number().int().positive().optional(),
      resultsCount: z.number().int().min(0),
      floorPrice: z.number().int().min(0).nullable().optional(),
    })
    .strict(),
});

export const filterChangeActivitySchema = baseActivityEvent.extend({
  type: z.literal('filter_change'),
  metadata: z
    .object({
      filterId: z.string().guid().optional(),
      action: z.enum(['created', 'updated', 'deleted', 'activated', 'deactivated']),
    })
    .strict(),
});

export const settingsChangeActivitySchema = baseActivityEvent.extend({
  type: z.literal('settings_change'),
  metadata: z
    .object({
      fields: z.array(z.string().min(1).max(80)).max(50),
    })
    .strict(),
});

export const errorActivitySchema = baseActivityEvent.extend({
  type: z.literal('error'),
  metadata: z
    .object({
      code: z.string().min(1).max(80),
      message: z.string().min(1).max(2000),
      context: z.string().min(1).max(120).optional(), // e.g. 'engine.governor', 'adapter.probe'
    })
    .strict(),
});

const paceCount = z.number().int().min(0).max(100_000);
const paceMs = z.number().int().min(0).max(3_600_000);

/** The Nova AI bot's pace over one report window (every two minutes while
 * it runs, content/index.ts): how often it really searched and what held it
 * back. A search that finds nothing is not reported on its own (`search`
 * events carry only searches with listings), so without this the search
 * cadence cannot be told from the data. Counts only, never listings. */
export const botPaceSchema = z
  .object({
    /** The time this report covers. */
    windowMs: paceMs.min(1),
    /** Searches sent, those that came back with listings, and failed ones. */
    searches: paceCount,
    withResults: paceCount,
    failed: paceCount,
    /** Search round trip (sent to EA's answer), median and 90th percentile;
     * null with no answered search. */
    searchMsP50: paceMs.nullable(),
    searchMsP90: paceMs.nullable(),
    /** Time spent in each kind of wait: the search delay, an EA backoff, a
     * limit holding the bot back, a break or rest, the pause after a buy. */
    waitingMs: paceMs,
    backoffMs: paceMs,
    blockedMs: paceMs,
    breakMs: paceMs,
    cooldownMs: paceMs,
  })
  .strict();
export type BotPace = z.infer<typeof botPaceSchema>;

export const heartbeatActivitySchema = baseActivityEvent.extend({
  type: z.literal('heartbeat'),
  metadata: z
    .object({
      extensionVersion: z.string().min(1).max(30),
      engineState: z.enum(['idle', 'running', 'paused', 'halted']).optional(),
      /** Set while the Nova AI bot runs: its pace since the last report. */
      bot: botPaceSchema.optional(),
    })
    .strict(),
});

export const activityEventSchema = z.discriminatedUnion('type', [
  loginActivitySchema,
  logoutActivitySchema,
  searchActivitySchema,
  filterChangeActivitySchema,
  settingsChangeActivitySchema,
  errorActivitySchema,
  heartbeatActivitySchema,
]);
export type ActivityEvent = z.infer<typeof activityEventSchema>;

/** `POST /activity` — the extension batches events client-side and flushes
 * on an interval/threshold (mirrors `content.js`'s existing flush batching,
 * ported to the account-agnostic events above). */
export const activityIngestBatchSchema = z
  .object({
    events: z.array(activityEventSchema).min(1).max(500),
  })
  .strict();
export type ActivityIngestBatch = z.infer<typeof activityIngestBatchSchema>;

// ---------------------------------------------------------------------------
// Admin activity monitoring — response row schemas for `GET
// /admin/activity/*` (docs/07-dashboard.md §11 gap #4: these routes
// previously declared no Zod `response` schema, so `apps/api/src/modules/
// admin-activity/index.ts`'s handlers typed as `content?: never` in the
// generated OpenAPI spec and the dashboard could only render a generic
// best-effort row). One schema per tab on `/admin/activity`, matching the
// `user_activity`/`search_activity`/`sniping_activity`/`ip_activity` row
// shapes those routes query (packages/db's schema/activity.ts,
// schema/system.ts) — `logins`/`errors` both read `user_activity` filtered
// by `type`, so they share `adminUserActivityRowSchema` typed to their one
// literal `type` each.
// ---------------------------------------------------------------------------

const adminActivityRowBase = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  deviceId: z.string().guid().nullable(),
  occurredAt: z.string().datetime(),
});

/** `GET /admin/activity/logins` — `user_activity` rows where `type = 'login'`. */
export const adminLoginActivityRowSchema = adminActivityRowBase.extend({
  type: z.literal('login'),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AdminLoginActivityRow = z.infer<typeof adminLoginActivityRowSchema>;

/** `GET /admin/activity/errors` — `user_activity` rows where `type = 'error'`. */
export const adminErrorActivityRowSchema = adminActivityRowBase.extend({
  type: z.literal('error'),
  ip: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AdminErrorActivityRow = z.infer<typeof adminErrorActivityRowSchema>;

/** `GET /admin/activity/filter-changes` — `user_activity` rows where
 * `type = 'filter_change'` (`filterChangeActivitySchema`'s ingest shape,
 * above). Previously the only `user_activity` type with no dedicated admin
 * route at all. */
export const adminFilterChangeActivityRowSchema = adminActivityRowBase.extend({
  type: z.literal('filter_change'),
  metadata: z.object({
    filterId: z.string().guid().optional(),
    action: z.enum(['created', 'updated', 'deleted', 'activated', 'deactivated']),
  }),
});
export type AdminFilterChangeActivityRow = z.infer<typeof adminFilterChangeActivityRowSchema>;

/** `GET /admin/activity/searches` — `search_activity` rows. */
export const adminSearchActivityRowSchema = adminActivityRowBase.extend({
  filterHash: z.string(),
  resultsCount: z.number().int().min(0),
  resourceId: z.string().nullable(),
  floorPrice: z.number().int().nullable(),
});
export type AdminSearchActivityRow = z.infer<typeof adminSearchActivityRowSchema>;

/** `GET /admin/activity/snipes` — `sniping_activity` rows. */
export const adminSnipeActivityRowSchema = adminActivityRowBase.extend({
  resourceId: z.string(),
  tradeId: z.string().nullable(),
  targetPrice: z.number().int(),
  listedPrice: z.number().int().nullable(),
  outcome: z.enum(SNIPE_OUTCOMES),
  latencyMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
});
export type AdminSnipeActivityRow = z.infer<typeof adminSnipeActivityRowSchema>;

/** `GET /admin/activity/devices` — extension version/OS distribution summary. */
export const adminActivityDevicesSummarySchema = z.object({
  byVersion: z.record(z.string(), z.number().int().min(0)),
  byOs: z.record(z.string(), z.number().int().min(0)),
  total: z.number().int().min(0),
});
export type AdminActivityDevicesSummary = z.infer<typeof adminActivityDevicesSummarySchema>;

/** `GET /admin/activity/ips` — `ip_activity` rows. */
export const adminIpActivityRowSchema = z.object({
  ip: z.string(),
  userId: z.string().guid().nullable(),
  country: z.string().nullable(),
  asn: z.number().int().nullable(),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  requestCount: z.number().int().min(0),
  flagged: z.boolean(),
});
export type AdminIpActivityRow = z.infer<typeof adminIpActivityRowSchema>;

// ---------------------------------------------------------------------------
// Admin bot performance — `GET /admin/bot-performance`: how fast the Nova AI
// bot searches and reacts, whether it wins the race for listings, and where
// its time goes, over a time range (the dashboard's `/admin/performance`).
// Two sources: `sniping_activity` (one row per buy attempt, with
// `search_ms`/`reaction_ms`/`latency_ms`) and the bot pace on `heartbeat`
// rows (`botPaceSchema` above). Formulas in docs/08-analytics.md.
//
// Outcomes: won = `success`; lost = `failed` or `too_slow` (someone else's
// buy landed first); `blocked` = the bot's own limits held it back (no buy
// was sent, so it never counts toward timings); `error` = EA 429/5xx;
// `attempted` = timed out with an unknown result.
// ---------------------------------------------------------------------------

/** The range a query covers when it gives none: the last 24 hours. */
export const BOT_PERFORMANCE_DEFAULT_RANGE_MS = 24 * 3_600_000;
/** The longest range one request may cover. */
export const BOT_PERFORMANCE_MAX_RANGE_DAYS = 31;

/** The instants a bot-performance query covers, both ends inclusive: `to`
 * defaults to now, `from` to 24 hours before `to`. */
export function resolveBotPerformanceRange(
  query: { from?: string; to?: string },
  now: Date = new Date(),
): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - BOT_PERFORMANCE_DEFAULT_RANGE_MS);
  return { from, to };
}

export const adminBotPerformanceQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    /** One user's bot. Omit for every user. */
    userId: z.string().guid().optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    const { from, to } = resolveBotPerformanceRange(query);
    if (from.getTime() > to.getTime()) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'from must not be after to' });
    } else if (to.getTime() - from.getTime() > BOT_PERFORMANCE_MAX_RANGE_DAYS * 86_400_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: `The range can cover at most ${BOT_PERFORMANCE_MAX_RANGE_DAYS} days`,
      });
    }
  });
export type AdminBotPerformanceQuery = z.infer<typeof adminBotPerformanceQuerySchema>;

const botMs = z.number().int().min(0).nullable();
const botCount = z.number().int().min(0);
const botShare = z.number().min(0).max(1);

/** Median and 90th percentile of one timing, in ms; null with no sample. */
export const botTimingPercentilesSchema = z.object({ p50: botMs, p90: botMs });
export type BotTimingPercentiles = z.infer<typeof botTimingPercentilesSchema>;

/** The three timings of a buy attempt, over one group of attempts. */
export const botAttemptTimingsSchema = z.object({
  /** Attempts in the group. */
  attempts: botCount,
  /** `search_ms`: the search being sent to the listing arriving. */
  search: botTimingPercentilesSchema,
  /** `reaction_ms`: the listing arriving to the bot sending its buy. */
  reaction: botTimingPercentilesSchema,
  /** `latency_ms`: the buy request's round trip to EA. */
  buy: botTimingPercentilesSchema,
});
export type BotAttemptTimings = z.infer<typeof botAttemptTimingsSchema>;

/** One UTC hour of the range. Every hour is present, zero-filled. */
export const adminBotPerformanceHourSchema = z.object({
  /** Start of the hour (UTC). */
  hour: z.string().datetime(),
  /** Searches the bot reported in its pace this hour. */
  searches: botCount,
  /** searches × 60000 / reported running time; null without pace reports. */
  searchesPerMinute: z.number().min(0).nullable(),
  attempts: botCount,
  won: botCount,
  lost: botCount,
  /** Medians over the hour's non-blocked attempts. */
  searchP50: botMs,
  reactionP50: botMs,
  buyP50: botMs,
});
export type AdminBotPerformanceHour = z.infer<typeof adminBotPerformanceHourSchema>;

export const adminBotPerformanceResponseSchema = z.object({
  /** The range covered (inclusive), after defaults. */
  from: z.string().datetime(),
  to: z.string().datetime(),
  /** The one user covered, or null for every user. */
  userId: z.string().guid().nullable(),
  summary: z.object({
    /** Every buy attempt in the range, whatever its outcome. */
    attempts: botCount,
    won: botCount,
    lost: botCount,
    blocked: botCount,
    errors: botCount,
    /** Timed out with an unknown result (`attempted`). */
    unknown: botCount,
    /** won / (won + lost); null when neither happened. */
    winRate: botShare.nullable(),
    /** From the bot pace: searches sent, those with listings, failed ones. */
    searches: botCount,
    searchesWithResults: botCount,
    failedSearches: botCount,
    /** searches × 60000 / runningMs; null without pace reports. */
    searchesPerMinute: z.number().min(0).nullable(),
    /** The bot's running time its pace reports cover (sum of `windowMs`). */
    runningMs: botCount,
  }),
  /** Over non-blocked attempts: all of them, the won ones, the lost ones. */
  timings: z.object({
    overall: botAttemptTimingsSchema,
    won: botAttemptTimingsSchema,
    lost: botAttemptTimingsSchema,
  }),
  /** Share of the reported running time in each kind of wait: the search
   * delay, an EA backoff, a limit holding the bot back, a break or rest,
   * the pause after a buy; `other` is the rest (searching, waiting for EA's
   * answers, buying). Null without pace reports. */
  timeSplit: z
    .object({
      delay: botShare,
      backoff: botShare,
      limit: botShare,
      break: botShare,
      cooldown: botShare,
      other: botShare,
    })
    .nullable(),
  hourly: z.array(adminBotPerformanceHourSchema),
});
export type AdminBotPerformanceResponse = z.infer<typeof adminBotPerformanceResponseSchema>;
