// Matches migrations/0017_coupons.sql, 0018_billing.sql.

import { relations } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  couponTypeEnum,
  createdAt,
  deletedAt,
  idPk,
  paymentProviderEnum,
  paymentStatusEnum,
  rowVersion,
  timestamptz,
  updatedAt,
} from './common';
import { users } from './users';
import { subscriptions } from './subscriptions';

export const coupons = pgTable(
  'coupons',
  {
    id: idPk(),

    code: text('code').notNull(),
    type: couponTypeEnum('type').notNull(),
    value: integer('value').notNull(),
    planIds: uuid('plan_ids').array().notNull().default([]),

    maxRedemptions: integer('max_redemptions'),
    redeemedCount: integer('redeemed_count').notNull().default(0),
    expiresAt: timestamptz('expires_at'),

    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

    deletedAt: deletedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('coupons_code_unique_live').on(t.code).where(t.deletedAt.isNull()),
    index('coupons_is_active_idx').on(t.isActive).where(t.deletedAt.isNull()),
    index('coupons_expires_at_idx').on(t.expiresAt).where(t.deletedAt.isNull()),
  ],
);

export const couponsRelations = relations(coupons, ({ many }) => ({
  redemptions: many(couponRedemptions),
  payments: many(payments),
}));

// ---------------------------------------------------------------------------

export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: idPk(),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => coupons.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),

    redeemedAt: timestamptz('redeemed_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('coupon_redemptions_coupon_user_unique').on(t.couponId, t.userId),
    index('coupon_redemptions_coupon_id_idx').on(t.couponId),
    index('coupon_redemptions_user_id_idx').on(t.userId),
    index('coupon_redemptions_subscription_id_idx').on(t.subscriptionId),
  ],
);

export const couponRedemptionsRelations = relations(couponRedemptions, ({ one }) => ({
  coupon: one(coupons, { fields: [couponRedemptions.couponId], references: [coupons.id] }),
  user: one(users, { fields: [couponRedemptions.userId], references: [users.id] }),
  subscription: one(subscriptions, { fields: [couponRedemptions.subscriptionId], references: [subscriptions.id] }),
}));

// ---------------------------------------------------------------------------

export const payments = pgTable(
  'payments',
  {
    id: idPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'restrict' }),

    provider: paymentProviderEnum('provider').notNull().default('stripe'),
    providerPaymentId: text('provider_payment_id').notNull(),

    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    status: paymentStatusEnum('status').notNull().default('pending'),

    couponId: uuid('coupon_id').references(() => coupons.id, { onDelete: 'set null' }),
    invoiceUrl: text('invoice_url'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('payments_provider_payment_id_unique').on(t.provider, t.providerPaymentId),
    index('payments_user_id_idx').on(t.userId, t.createdAt),
    index('payments_subscription_id_idx').on(t.subscriptionId),
    index('payments_status_idx').on(t.status),
    index('payments_coupon_id_idx').on(t.couponId),
  ],
);

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  user: one(users, { fields: [payments.userId], references: [users.id] }),
  subscription: one(subscriptions, { fields: [payments.subscriptionId], references: [subscriptions.id] }),
  coupon: one(coupons, { fields: [payments.couponId], references: [coupons.id] }),
  history: many(paymentHistory),
}));

// ---------------------------------------------------------------------------

export const paymentHistory = pgTable(
  'payment_history',
  {
    id: idPk(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),

    event: text('event').notNull(),
    rawEvent: jsonb('raw_event').notNull().default({}).$type<Record<string, unknown>>(),

    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('payment_history_payment_id_idx').on(t.paymentId, t.occurredAt),
    index('payment_history_event_idx').on(t.event),
  ],
);

export const paymentHistoryRelations = relations(paymentHistory, ({ one }) => ({
  payment: one(payments, { fields: [paymentHistory.paymentId], references: [payments.id] }),
}));

// ---------------------------------------------------------------------------

export const stripeWebhookEvents = pgTable(
  'stripe_webhook_events',
  {
    id: idPk(),
    eventId: text('event_id').notNull(),

    type: text('type').notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    processedAt: timestamptz('processed_at'),
    error: text('error'),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('stripe_webhook_events_event_id_unique').on(t.eventId),
    index('stripe_webhook_events_type_idx').on(t.type),
    index('stripe_webhook_events_unprocessed_idx').on(t.createdAt).where(t.processedAt.isNull()),
  ],
);
