// Matches migrations/0003_users.sql.

import { isNull, relations } from 'drizzle-orm';
import { customType, index, integer, pgTable, smallint, text, uniqueIndex, uuid, inet } from 'drizzle-orm/pg-core';
import { citext, createdAt, deletedAt, idPk, rowVersion, timestamptz, updatedAt, userRoleEnum, userStatusEnum } from './common';
import { subscriptions } from './subscriptions';
import { devices } from './auth';
import { adminUsers } from './admin';

// bytea passthrough for the encrypted TOTP secret; Buffer in/out.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable(
  'users',
  {
    id: idPk(),

    email: citext('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: timestamptz('email_verified_at'),

    status: userStatusEnum('status').notNull().default('active'),
    role: userRoleEnum('role').notNull().default('user'),

    totpSecretEnc: bytea('totp_secret_enc'),
    totpEnabledAt: timestamptz('totp_enabled_at'),

    failedLoginCount: smallint('failed_login_count').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),

    lastLoginAt: timestamptz('last_login_at'),
    lastIp: inet('last_ip'),

    timezone: text('timezone').notNull().default('UTC'),
    referralCode: text('referral_code'),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('users_email_unique_live').on(t.email).where(isNull(t.deletedAt)),
    uniqueIndex('users_referral_code_unique_live')
      .on(t.referralCode)
      .where(isNull(t.deletedAt)),
    index('users_status_idx').on(t.status).where(isNull(t.deletedAt)),
    index('users_role_idx').on(t.role).where(isNull(t.deletedAt)),
    index('users_created_at_idx').on(t.createdAt),
    index('users_last_login_at_idx').on(t.lastLoginAt).where(isNull(t.deletedAt)),
  ],
);

export const usersRelations = relations(users, ({ many, one }) => ({
  subscriptions: many(subscriptions),
  devices: many(devices),
  adminProfile: one(adminUsers, {
    fields: [users.id],
    references: [adminUsers.userId],
  }),
}));
