// Matches migrations/0003_users.sql, plus the additive columns from
// migrations/0025_users_stripe_customer_trial_abuse.sql.

import { isNotNull, isNull, relations } from 'drizzle-orm';
import { customType, index, inet, pgTable, smallint, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { adminUsers } from './admin.js';
import { devices } from './auth.js';
import {
  citext,
  createdAt,
  deletedAt,
  idPk,
  rowVersion,
  timestamptz,
  updatedAt,
  userRoleEnum,
  userStatusEnum,
} from './common.js';
import { subscriptions } from './subscriptions.js';

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

    termsVersion: smallint('terms_version'),
    termsAcceptedAt: timestamptz('terms_accepted_at'),
    lastIp: inet('last_ip'),

    timezone: text('timezone').notNull().default('UTC'),
    referralCode: text('referral_code'),

    // Added by migrations/0025_users_stripe_customer_trial_abuse.sql.
    // stripeCustomerId: persisted by the payments module on checkout
    // completion / portal session creation; also the trial-abuse "4th
    // vector" (docs/05-subscriptions.md §5). emailNormalised: a Postgres
    // GENERATED STORED column (not application-written — see that
    // migration's comments), included here only so query code can read it
    // (`db.query.users...`/`eq(users.emailNormalised, ...)`); never set it
    // in an insert/update — Postgres computes and stores it, and rejects a
    // write that tries to set it explicitly.
    stripeCustomerId: text('stripe_customer_id'),
    emailNormalised: text('email_normalised'),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('users_email_unique_live').on(t.email).where(isNull(t.deletedAt)),
    uniqueIndex('users_referral_code_unique_live').on(t.referralCode).where(isNull(t.deletedAt)),
    index('users_status_idx').on(t.status).where(isNull(t.deletedAt)),
    index('users_role_idx').on(t.role).where(isNull(t.deletedAt)),
    index('users_created_at_idx').on(t.createdAt),
    index('users_last_login_at_idx').on(t.lastLoginAt).where(isNull(t.deletedAt)),
    uniqueIndex('users_stripe_customer_id_unique')
      .on(t.stripeCustomerId)
      .where(isNotNull(t.stripeCustomerId)),
    index('users_email_normalised_idx').on(t.emailNormalised).where(isNull(t.deletedAt)),
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
