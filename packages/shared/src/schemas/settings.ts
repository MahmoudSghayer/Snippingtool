import { z } from 'zod';

/**
 * Absolute floor/ceiling for governor thresholds. These are hard limits this
 * schema itself enforces (no user or admin can configure outside them); the
 * *admin-tunable default* min/max a given plan is allowed to set within this
 * range lives in `system_config` (`packages/db`) and is applied as an extra
 * server-side check in `apps/api`'s settings module, because those bounds
 * can change without a redeploy. Keeping the absolute limits here means the
 * extension can validate optimistically before it ever calls the API.
 */
export const GOVERNOR_ABSOLUTE_LIMITS = {
  actionsPerHour: { min: 1, max: 120 },
  sessionLengthMinutes: { min: 5, max: 240 },
  buyToSearchRatio: { min: 0.01, max: 1 },
  cooldownSeconds: { min: 0, max: 3600 },
} as const;

const boundedInt = (bound: { min: number; max: number }) =>
  z.number().int().min(bound.min).max(bound.max);

const boundedFloat = (bound: { min: number; max: number }) =>
  z.number().min(bound.min).max(bound.max);

/** The safety governor's tunable thresholds (docs/01-architecture.md,
 * "safety governor"). These are the numbers behind the risk budget meter —
 * a user can tighten them, never loosen them past the plan's admin-set
 * ceiling. */
export const governorSettingsSchema = z.object({
  actionsPerHour: boundedInt(GOVERNOR_ABSOLUTE_LIMITS.actionsPerHour),
  sessionLengthMinutes: boundedInt(GOVERNOR_ABSOLUTE_LIMITS.sessionLengthMinutes),
  buyToSearchRatio: boundedFloat(GOVERNOR_ABSOLUTE_LIMITS.buyToSearchRatio),
  cooldownSeconds: boundedInt(GOVERNOR_ABSOLUTE_LIMITS.cooldownSeconds),
});
export type GovernorSettings = z.infer<typeof governorSettingsSchema>;

export const DEFAULT_GOVERNOR_SETTINGS: GovernorSettings = {
  actionsPerHour: 30,
  sessionLengthMinutes: 90,
  buyToSearchRatio: 0.35,
  cooldownSeconds: 20,
};

/** What the extension is trying to achieve — the ranker scores opportunities
 * against these. */
export const targetsSchema = z.object({
  minProfitPerSnipe: z.number().int().min(0).max(10_000_000),
  dailyProfitGoal: z.number().int().min(0).max(100_000_000).nullable(),
});
export type Targets = z.infer<typeof targetsSchema>;

export const budgetsSchema = z.object({
  maxCoinsPerSnipe: z.number().int().min(0).max(100_000_000),
  sessionCoinBudget: z.number().int().min(0).max(1_000_000_000).nullable(),
});
export type Budgets = z.infer<typeof budgetsSchema>;

export const notificationPrefsSchema = z.object({
  email: z.boolean(),
  push: z.boolean(),
  killSwitch: z.boolean(), // cannot be fully disabled server-side, but controls extra channels
  subscriptionChanges: z.boolean(),
  weeklyDigest: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  email: true,
  push: false,
  killSwitch: true,
  subscriptionChanges: true,
  weeklyDigest: false,
};

/** The full `user_settings.settings` JSONB document. `version` lets the
 * extension detect a server-side reset (e.g. an admin lowered a bound) and
 * is bumped by `apps/api` on every write; `settings_history` keeps prior
 * versions. */
export const userSettingsSchema = z.object({
  version: z.number().int().min(1),
  targets: targetsSchema,
  budgets: budgetsSchema,
  governor: governorSettingsSchema,
  telemetryOptOut: z.boolean(),
  notifications: notificationPrefsSchema,
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

/** PATCH body: every section optional, applied as a merge server-side. */
export const updateUserSettingsRequestSchema = z.object({
  targets: targetsSchema.partial().optional(),
  budgets: budgetsSchema.partial().optional(),
  governor: governorSettingsSchema.partial().optional(),
  telemetryOptOut: z.boolean().optional(),
  notifications: notificationPrefsSchema.partial().optional(),
});
export type UpdateUserSettingsRequest = z.infer<typeof updateUserSettingsRequestSchema>;
