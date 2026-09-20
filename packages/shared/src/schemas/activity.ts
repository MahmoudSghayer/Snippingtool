import { z } from 'zod';

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

const baseActivityEvent = z.object({
  occurredAt: z.string().datetime(),
  deviceId: z.string().uuid().optional(), // absent before device registration completes
});

export const loginActivitySchema = baseActivityEvent.extend({
  type: z.literal('login'),
  metadata: z.object({ mfaUsed: z.boolean().optional() }).optional(),
});

export const logoutActivitySchema = baseActivityEvent.extend({
  type: z.literal('logout'),
  metadata: z.object({ reason: z.enum(['user', 'forced', 'expired']).optional() }).optional(),
});

/** `filterHash` + `resultsCount` only — never the listings. See
 * `savedFilterSchema` for the filter shape this hashes. */
export const searchActivitySchema = baseActivityEvent.extend({
  type: z.literal('search'),
  metadata: z.object({
    filterHash: z.string().min(1).max(128),
    resourceId: z.number().int().positive().optional(),
    resultsCount: z.number().int().min(0),
    floorPrice: z.number().int().min(0).nullable().optional(),
  }),
});

export const filterChangeActivitySchema = baseActivityEvent.extend({
  type: z.literal('filter_change'),
  metadata: z.object({
    filterId: z.string().uuid().optional(),
    action: z.enum(['created', 'updated', 'deleted', 'activated', 'deactivated']),
  }),
});

export const settingsChangeActivitySchema = baseActivityEvent.extend({
  type: z.literal('settings_change'),
  metadata: z.object({
    fields: z.array(z.string().min(1).max(80)).max(50),
  }),
});

export const errorActivitySchema = baseActivityEvent.extend({
  type: z.literal('error'),
  metadata: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(2000),
    context: z.string().min(1).max(120).optional(), // e.g. 'engine.governor', 'adapter.probe'
  }),
});

export const heartbeatActivitySchema = baseActivityEvent.extend({
  type: z.literal('heartbeat'),
  metadata: z.object({
    extensionVersion: z.string().min(1).max(30),
    engineState: z.enum(['idle', 'running', 'paused', 'halted']).optional(),
  }),
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
export const activityIngestBatchSchema = z.object({
  events: z.array(activityEventSchema).min(1).max(500),
});
export type ActivityIngestBatch = z.infer<typeof activityIngestBatchSchema>;
