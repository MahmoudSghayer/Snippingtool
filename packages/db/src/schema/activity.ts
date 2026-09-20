// Matches migrations/0011_activity_partitioned.sql, 0014_risk_budget_events.sql.
//
// user_activity/search_activity/sniping_activity are declaratively
// partitioned by month in SQL (see migrations); Drizzle only needs the
// logical column shape to query through the parent, so they're modelled as
// ordinary tables here with the same composite primary key
// (id, occurred_at) the partitioning requires. Drizzle never creates or
// alters these tables (see src/index.ts / docs/02-database.md).

import { relations } from 'drizzle-orm';
import { index, inet, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { devices, sessions } from './auth.js';
import { createdAt, riskEventKindEnum, snipingOutcomeEnum, timestamptz, userActivityTypeEnum } from './common.js';
import { users } from './users.js';

export const userActivity = pgTable(
  'user_activity',
  {
    id: uuid('id').notNull().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),

    type: userActivityTypeEnum('type').notNull(),
    ip: inet('ip'),
    metadata: jsonb('metadata').notNull().default({}).$type<Record<string, unknown>>(),

    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index('user_activity_user_id_idx').on(t.userId, t.occurredAt),
    index('user_activity_device_id_idx').on(t.deviceId, t.occurredAt),
    index('user_activity_type_idx').on(t.type, t.occurredAt),
  ],
);

export const userActivityRelations = relations(userActivity, ({ one }) => ({
  user: one(users, { fields: [userActivity.userId], references: [users.id] }),
  device: one(devices, { fields: [userActivity.deviceId], references: [devices.id] }),
}));

// ---------------------------------------------------------------------------

export const searchActivity = pgTable(
  'search_activity',
  {
    id: uuid('id').notNull().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),

    filterHash: text('filter_hash').notNull(),
    filter: jsonb('filter').notNull().$type<Record<string, unknown>>(),
    resultsCount: integer('results_count').notNull(),
    resourceId: text('resource_id'),
    floorPrice: integer('floor_price'),

    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index('search_activity_user_id_idx').on(t.userId, t.occurredAt),
    index('search_activity_device_id_idx').on(t.deviceId, t.occurredAt),
    index('search_activity_filter_hash_idx').on(t.filterHash, t.occurredAt),
    index('search_activity_resource_id_idx').on(t.resourceId, t.occurredAt),
  ],
);

export const searchActivityRelations = relations(searchActivity, ({ one }) => ({
  user: one(users, { fields: [searchActivity.userId], references: [users.id] }),
  device: one(devices, { fields: [searchActivity.deviceId], references: [devices.id] }),
}));

// ---------------------------------------------------------------------------

export const snipingActivity = pgTable(
  'sniping_activity',
  {
    id: uuid('id').notNull().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),

    resourceId: text('resource_id').notNull(),
    tradeId: text('trade_id'),
    targetPrice: integer('target_price').notNull(),
    listedPrice: integer('listed_price'),
    outcome: snipingOutcomeEnum('outcome').notNull(),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),

    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index('sniping_activity_user_id_idx').on(t.userId, t.occurredAt),
    index('sniping_activity_device_id_idx').on(t.deviceId, t.occurredAt),
    index('sniping_activity_resource_id_idx').on(t.resourceId, t.occurredAt),
    index('sniping_activity_trade_id_idx').on(t.tradeId),
    index('sniping_activity_outcome_idx').on(t.outcome, t.occurredAt),
  ],
);

export const snipingActivityRelations = relations(snipingActivity, ({ one }) => ({
  user: one(users, { fields: [snipingActivity.userId], references: [users.id] }),
  device: one(devices, { fields: [snipingActivity.deviceId], references: [devices.id] }),
}));

// ---------------------------------------------------------------------------

export const riskBudgetEvents = pgTable(
  'risk_budget_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),

    kind: riskEventKindEnum('kind').notNull(),
    value: text('value').notNull(), // numeric(14,4) — kept as text to avoid silent float rounding; parse in app layer.
    threshold: text('threshold').notNull(),

    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('risk_budget_events_user_id_idx').on(t.userId, t.occurredAt),
    index('risk_budget_events_device_id_idx').on(t.deviceId, t.occurredAt),
    index('risk_budget_events_session_id_idx').on(t.sessionId),
    index('risk_budget_events_kind_idx').on(t.kind, t.occurredAt),
  ],
);

export const riskBudgetEventsRelations = relations(riskBudgetEvents, ({ one }) => ({
  user: one(users, { fields: [riskBudgetEvents.userId], references: [users.id] }),
  device: one(devices, { fields: [riskBudgetEvents.deviceId], references: [devices.id] }),
  session: one(sessions, { fields: [riskBudgetEvents.sessionId], references: [sessions.id] }),
}));
