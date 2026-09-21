import { z } from 'zod';

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
    occurredAt: z.string().datetime(),
    deviceId: z.string().uuid().optional(), // absent before device registration completes
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
      filterId: z.string().uuid().optional(),
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

export const heartbeatActivitySchema = baseActivityEvent.extend({
  type: z.literal('heartbeat'),
  metadata: z
    .object({
      extensionVersion: z.string().min(1).max(30),
      engineState: z.enum(['idle', 'running', 'paused', 'halted']).optional(),
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
  id: z.string().uuid(),
  userId: z.string().uuid(),
  deviceId: z.string().uuid().nullable(),
  occurredAt: z.string().datetime(),
});

/** `GET /admin/activity/logins` — `user_activity` rows where `type = 'login'`. */
export const adminLoginActivityRowSchema = adminActivityRowBase.extend({
  type: z.literal('login'),
  ip: z.string().nullable(),
  metadata: z.record(z.unknown()),
});
export type AdminLoginActivityRow = z.infer<typeof adminLoginActivityRowSchema>;

/** `GET /admin/activity/errors` — `user_activity` rows where `type = 'error'`. */
export const adminErrorActivityRowSchema = adminActivityRowBase.extend({
  type: z.literal('error'),
  ip: z.string().nullable(),
  metadata: z.record(z.unknown()),
});
export type AdminErrorActivityRow = z.infer<typeof adminErrorActivityRowSchema>;

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
  byVersion: z.record(z.number().int().min(0)),
  byOs: z.record(z.number().int().min(0)),
  total: z.number().int().min(0),
});
export type AdminActivityDevicesSummary = z.infer<typeof adminActivityDevicesSummarySchema>;

/** `GET /admin/activity/ips` — `ip_activity` rows. */
export const adminIpActivityRowSchema = z.object({
  ip: z.string(),
  userId: z.string().uuid().nullable(),
  country: z.string().nullable(),
  asn: z.number().int().nullable(),
  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),
  requestCount: z.number().int().min(0),
  flagged: z.boolean(),
});
export type AdminIpActivityRow = z.infer<typeof adminIpActivityRowSchema>;
