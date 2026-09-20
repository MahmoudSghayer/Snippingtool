import { z } from 'zod';

import { PERMISSIONS } from '../permissions.js';

/** `audit_logs` row shape, as the dashboard's diff viewer renders it.
 * `before`/`after` are the app-layer diffing JSONB columns; `diff` is
 * precomputed server-side so the dashboard never has to. */
export const auditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorType: z.enum(['user', 'admin', 'system']),
  actorId: z.string().uuid().nullable(),
  action: z.string().min(1).max(120),
  entityType: z.string().min(1).max(80),
  // Nullable: audit_logs.entity_id is a nullable uuid in the DB (some
  // system-actor actions have no single target entity) — widened here
  // (additive) to match; existing string-only consumers keep working.
  entityId: z.string().min(1).max(80).nullable(),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  diff: z.record(z.unknown()).nullable(),
  requestId: z.string().min(1).max(80).nullable(),
  occurredAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogQuerySchema = z
  .object({
    actorId: z.string().uuid().optional(),
    entityType: z.string().min(1).max(80).optional(),
    // audit_logs.entity_id is a `uuid` column (02-database.md §6.9) — validated
    // here so a malformed filter value 400s as VALIDATION_FAILED instead of
    // reaching the database and raising a Postgres type-cast error (500).
    entityId: z.string().uuid().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

/** Every admin mutation carries a `reason`, which lands in `admin_actions`
 * and the resulting `audit_logs` row — enforced by this schema, not left to
 * convention. */
export const adminActionRequestSchema = z
  .object({
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type AdminActionRequest = z.infer<typeof adminActionRequestSchema>;

export const featureToggleDtoSchema = z.object({
  key: z.string().min(1).max(80),
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  planGate: z.string().min(1).max(40).nullable(),
  updatedBy: z.string().uuid().nullable(),
});
export type FeatureToggleDto = z.infer<typeof featureToggleDtoSchema>;

export const updateFeatureToggleRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    planGate: z.string().min(1).max(40).nullable().optional(),
  })
  .strict();
export type UpdateFeatureToggleRequest = z.infer<typeof updateFeatureToggleRequestSchema>;

export const systemConfigDtoSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.unknown(),
  isSecret: z.boolean(),
  updatedBy: z.string().uuid().nullable(),
});
export type SystemConfigDto = z.infer<typeof systemConfigDtoSchema>;

/** The permission set an admin session carries, as returned by `/auth/login`
 * / `/users/me` for an admin account — consumed by the dashboard to hide UI
 * the API would reject anyway. */
export const adminSessionSchema = z.object({
  adminRole: z.enum(['super_admin', 'support', 'analyst', 'billing']),
  permissions: z.array(z.enum(PERMISSIONS)),
});
export type AdminSession = z.infer<typeof adminSessionSchema>;
