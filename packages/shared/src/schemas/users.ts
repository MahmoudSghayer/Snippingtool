import { z } from 'zod';

import { emailSchema } from './auth.js';

export const USER_STATUSES = ['active', 'suspended', 'banned', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const userDtoSchema = z.object({
  id: z.string().uuid(),
  email: emailSchema,
  emailVerifiedAt: z.string().datetime().nullable(),
  status: z.enum(USER_STATUSES),
  role: z.enum(USER_ROLES),
  totpEnabled: z.boolean(),
  timezone: z.string().min(1).max(64).nullable(),
  referralCode: z.string().min(1).max(40).nullable(),
  createdAt: z.string().datetime(),
  lastLoginAt: z.string().datetime().nullable(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

// Mass-assignment defence (docs/09-security.md "Input validation"): every
// request schema below is `.strict()` — an unrecognised extra key is a 400,
// not a silently-stripped no-op.
export const updateProfileRequestSchema = z
  .object({
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** `admin/users` search + moderation filters. */
export const adminUserListQuerySchema = z
  .object({
    q: z.string().min(1).max(320).optional(), // email substring
    status: z.enum(USER_STATUSES).optional(),
    planCode: z.string().min(1).max(40).optional(),
  })
  .strict();
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const adminSuspendUserRequestSchema = z
  .object({
    reason: z.string().min(1).max(1000),
    expiresAt: z.string().datetime().nullable().optional(), // null/omitted = indefinite
  })
  .strict();
export type AdminSuspendUserRequest = z.infer<typeof adminSuspendUserRequestSchema>;

export const adminBanUserRequestSchema = z
  .object({
    type: z.enum(['account', 'ip', 'device', 'hwid']),
    value: z.string().min(1).max(320).optional(), // required for ip/device/hwid, ignored for account
    reason: z.string().min(1).max(1000),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();
export type AdminBanUserRequest = z.infer<typeof adminBanUserRequestSchema>;
