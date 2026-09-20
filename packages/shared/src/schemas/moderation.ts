import { z } from 'zod';

import { adminBanUserRequestSchema } from './users.js';

/**
 * Bans and abuse flags (`bans`/`flags` tables, `02-database.md` §6.8), owned
 * by `apps/api`'s `bans`/`flags` and `admin-bans`/`admin-flags` modules
 * (`docs/05-subscriptions.md` §6, §8).
 */

export const BAN_TYPES = ['account', 'ip', 'device', 'hwid'] as const;
export type BanType = (typeof BAN_TYPES)[number];

export const banDtoSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  type: z.enum(BAN_TYPES),
  value: z.string().max(320), // empty for an account ban, whose identity lives in `userId`
  reason: z.string().min(1).max(1000),
  issuedBy: z.string().uuid().nullable(),
  expiresAt: z.string().datetime().nullable(),
  liftedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type BanDto = z.infer<typeof banDtoSchema>;

/** Reuses `adminBanUserRequestSchema` from `schemas/users.ts` so
 * `/admin/users/:id/ban` (core `admin-users` module) and `/admin/bans`
 * (this module) accept the exact same request shape. */
export const createBanRequestSchema = adminBanUserRequestSchema
  .extend({
    userId: z.string().uuid().optional(), // required when type = 'account', ignored otherwise
  })
  .strict();
export type CreateBanRequest = z.infer<typeof createBanRequestSchema>;

export const liftBanRequestSchema = z
  .object({
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type LiftBanRequest = z.infer<typeof liftBanRequestSchema>;

/** What a login/auth check gets back from `checkBans()` — the auth module's
 * cross-agent touchpoint into this module's `bans` service
 * (`docs/05-subscriptions.md`, "Cross-agent touchpoints"). */
export const banCheckResultSchema = z.object({
  banned: z.boolean(),
  ban: banDtoSchema.nullable(),
});
export type BanCheckResult = z.infer<typeof banCheckResultSchema>;

// ---------------------------------------------------------------------------

export const FLAG_KINDS = ['trial_abuse', 'multi_account', 'velocity', 'chargeback', 'suspicious_ip'] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export const FLAG_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

export const FLAG_STATUSES = ['open', 'reviewed', 'dismissed'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

export const flagDtoSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(FLAG_KINDS),
  severity: z.enum(FLAG_SEVERITIES),
  evidence: z.record(z.unknown()),
  status: z.enum(FLAG_STATUSES),
  reviewedBy: z.string().uuid().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type FlagDto = z.infer<typeof flagDtoSchema>;

export const adminFlagListQuerySchema = z
  .object({
    status: z.enum(FLAG_STATUSES).optional(),
    kind: z.enum(FLAG_KINDS).optional(),
    severity: z.enum(FLAG_SEVERITIES).optional(),
    userId: z.string().uuid().optional(),
  })
  .strict();
export type AdminFlagListQuery = z.infer<typeof adminFlagListQuerySchema>;

export const reviewFlagRequestSchema = z
  .object({
    status: z.enum(['reviewed', 'dismissed']),
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type ReviewFlagRequest = z.infer<typeof reviewFlagRequestSchema>;
