// Matches migrations/0005_plans.sql, 0006_subscriptions.sql, 0007_licenses.sql.

import { isNull, relations } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  createdAt,
  deletedAt,
  idPk,
  licenseStatusEnum,
  rowVersion,
  subscriptionSourceEnum,
  subscriptionStatusEnum,
  timestamptz,
  updatedAt,
} from './common';
import { users } from './users';
import { adminUsers } from './admin';

export const plans = pgTable(
  'plans',
  {
    id: idPk(),

    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),

    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    interval: text('interval').notNull().default('month'),
    isLifetime: boolean('is_lifetime').notNull().default(false),

    deviceLimit: smallint('device_limit').notNull(),
    features: jsonb('features').notNull().default({}).$type<Record<string, unknown>>(),

    stripePriceId: text('stripe_price_id'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: smallint('sort_order').notNull().default(0),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('plans_code_unique_live').on(t.code).where(isNull(t.deletedAt)),
    uniqueIndex('plans_stripe_price_id_unique').on(t.stripePriceId).where(isNull(t.deletedAt)),
    index('plans_is_active_idx').on(t.isActive).where(isNull(t.deletedAt)),
  ],
);

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

// ---------------------------------------------------------------------------

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),

    status: subscriptionStatusEnum('status').notNull().default('trialing'),
    currentPeriodStart: timestamptz('current_period_start'),
    currentPeriodEnd: timestamptz('current_period_end'),
    trialEndsAt: timestamptz('trial_ends_at'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    autoRenew: boolean('auto_renew').notNull().default(true),

    stripeSubscriptionId: text('stripe_subscription_id'),
    source: subscriptionSourceEnum('source').notNull().default('stripe'),
    grantedByAdminId: uuid('granted_by_admin_id').references(() => adminUsers.id, { onDelete: 'set null' }),

    canceledAt: timestamptz('canceled_at'),
    endedAt: timestamptz('ended_at'),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('subscriptions_stripe_subscription_id_unique').on(t.stripeSubscriptionId),
    index('subscriptions_user_id_idx').on(t.userId).where(isNull(t.deletedAt)),
    index('subscriptions_plan_id_idx').on(t.planId).where(isNull(t.deletedAt)),
    index('subscriptions_status_idx').on(t.status).where(isNull(t.deletedAt)),
    index('subscriptions_current_period_end_idx').on(t.currentPeriodEnd).where(isNull(t.deletedAt)),
    index('subscriptions_trial_ends_at_idx').on(t.trialEndsAt).where(isNull(t.deletedAt)),
  ],
);

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
  grantedByAdmin: one(adminUsers, { fields: [subscriptions.grantedByAdminId], references: [adminUsers.id] }),
  licenses: many(licenses),
}));

// ---------------------------------------------------------------------------

export const licenses = pgTable(
  'licenses',
  {
    id: idPk(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),

    status: licenseStatusEnum('status').notNull().default('active'),
    maxDevices: smallint('max_devices').notNull(),
    expiresAt: timestamptz('expires_at'),

    lastValidatedAt: timestamptz('last_validated_at'),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('licenses_key_hash_unique').on(t.keyHash),
    index('licenses_subscription_id_idx').on(t.subscriptionId).where(isNull(t.deletedAt)),
    index('licenses_user_id_idx').on(t.userId).where(isNull(t.deletedAt)),
    index('licenses_status_idx').on(t.status).where(isNull(t.deletedAt)),
    index('licenses_expires_at_idx').on(t.expiresAt).where(isNull(t.deletedAt)),
    index('licenses_key_prefix_idx').on(t.keyPrefix),
  ],
);

export const licensesRelations = relations(licenses, ({ one }) => ({
  subscription: one(subscriptions, { fields: [licenses.subscriptionId], references: [subscriptions.id] }),
  user: one(users, { fields: [licenses.userId], references: [users.id] }),
}));
