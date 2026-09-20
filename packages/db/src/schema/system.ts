// Matches migrations/0020_audit_logs.sql, 0021_feature_system.sql,
// 0022_ip_installs.sql, 0023_analytics.sql.

import {
  bigint,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgMaterializedView,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
 date } from 'drizzle-orm/pg-core';

import { auditActorTypeEnum, createdAt, idPk, rowVersion, timestamptz, updatedAt } from './common.js';

// ---------------------------------------------------------------------------
// audit_logs: append-only, partitioned by month on occurred_at (see 0020).
// UPDATE/DELETE are revoked at the database role level and rejected by a
// trigger; Drizzle only ever SELECTs/INSERTs this table.
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').notNull().defaultRandom(),

    actorType: auditActorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'),

    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),

    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    diff: jsonb('diff').$type<Record<string, unknown> | null>(),

    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: uuid('request_id'),

    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index('audit_logs_actor_idx').on(t.actorType, t.actorId, t.occurredAt),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId, t.occurredAt),
    index('audit_logs_action_idx').on(t.action, t.occurredAt),
    index('audit_logs_request_id_idx').on(t.requestId),
  ],
);

// ---------------------------------------------------------------------------

export const featureToggles = pgTable(
  'feature_toggles',
  {
    id: idPk(),

    key: text('key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    rolloutPercent: smallint('rollout_percent').notNull().default(100),
    planGate: text('plan_gate').array().notNull().default([]),
    userAllowlist: uuid('user_allowlist').array().notNull().default([]),

    description: text('description'),
    updatedBy: uuid('updated_by'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [uniqueIndex('feature_toggles_key_unique').on(t.key), index('feature_toggles_enabled_idx').on(t.enabled)],
);

// ---------------------------------------------------------------------------

export const systemConfig = pgTable(
  'system_config',
  {
    id: idPk(),

    key: text('key').notNull(),
    value: jsonb('value').notNull().$type<unknown>(),
    isSecret: boolean('is_secret').notNull().default(false),
    description: text('description'),

    updatedBy: uuid('updated_by'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [uniqueIndex('system_config_key_unique').on(t.key)],
);

// ---------------------------------------------------------------------------

export const ipActivity = pgTable(
  'ip_activity',
  {
    id: idPk(),

    ip: inet('ip').notNull(),
    userId: uuid('user_id'),
    deviceId: uuid('device_id'),

    country: text('country'),
    asn: integer('asn'),

    firstSeen: timestamptz('first_seen').notNull().defaultNow(),
    lastSeen: timestamptz('last_seen').notNull().defaultNow(),
    requestCount: bigint('request_count', { mode: 'number' }).notNull().default(1),
    flagged: boolean('flagged').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    index('ip_activity_ip_idx').on(t.ip),
    index('ip_activity_user_id_idx').on(t.userId),
    index('ip_activity_flagged_idx').on(t.flagged),
  ],
);

// ---------------------------------------------------------------------------

export const extensionInstalls = pgTable(
  'extension_installs',
  {
    id: idPk(),

    installId: text('install_id').notNull(),
    userId: uuid('user_id'),

    version: text('version').notNull(),
    browser: text('browser'),

    firstSeen: timestamptz('first_seen').notNull().defaultNow(),
    lastSeen: timestamptz('last_seen').notNull().defaultNow(),
    uninstalledAt: timestamptz('uninstalled_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('extension_installs_install_id_unique').on(t.installId),
    index('extension_installs_user_id_idx').on(t.userId),
    index('extension_installs_version_idx').on(t.version),
  ],
);

// ---------------------------------------------------------------------------

export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    id: idPk(),

    day: date('day', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    dimension: text('dimension').notNull().default(''),
    value: numeric('value', { precision: 18, scale: 4 }).notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [
    uniqueIndex('analytics_daily_day_metric_dimension_unique').on(t.day, t.metric, t.dimension),
    index('analytics_daily_metric_idx').on(t.metric, t.day),
  ],
);

// ---------------------------------------------------------------------------
// Views and the materialised KPI store are created in migrations/0023
// (they read from tables across every domain, so defining them here avoids
// a circular-import mess). `.existing()` tells Drizzle not to try to create
// them — they're query targets only.
// ---------------------------------------------------------------------------

export const vActiveSubscriptions = pgView('v_active_subscriptions', {
  id: uuid('id'),
  userId: uuid('user_id'),
  planId: uuid('plan_id'),
  planCode: text('plan_code'),
  planName: text('plan_name'),
  priceCents: integer('price_cents'),
  interval: text('interval'),
  isLifetime: boolean('is_lifetime'),
  status: text('status'),
  currentPeriodStart: timestamptz('current_period_start'),
  currentPeriodEnd: timestamptz('current_period_end'),
  trialEndsAt: timestamptz('trial_ends_at'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end'),
  autoRenew: boolean('auto_renew'),
  source: text('source'),
  createdAt: timestamptz('created_at'),
}).existing();

export const vMrr = pgView('v_mrr', {
  mrrCents: numeric('mrr_cents', { precision: 18, scale: 4 }),
}).existing();

export const vArr = pgView('v_arr', {
  arrCents: numeric('arr_cents', { precision: 18, scale: 4 }),
}).existing();

export const vUserLifetimeProfit = pgView('v_user_lifetime_profit', {
  userId: uuid('user_id'),
  lifetimeNetProfit: bigint('lifetime_net_profit', { mode: 'number' }),
  lifetimeCoinsSpent: bigint('lifetime_coins_spent', { mode: 'number' }),
  lifetimeCoinsEarned: bigint('lifetime_coins_earned', { mode: 'number' }),
  lifetimeSnipes: bigint('lifetime_snipes', { mode: 'number' }),
  lifetimeSuccesses: bigint('lifetime_successes', { mode: 'number' }),
  lifetimeTradesClosed: bigint('lifetime_trades_closed', { mode: 'number' }),
  firstActiveDay: date('first_active_day', { mode: 'string' }),
  lastActiveDay: date('last_active_day', { mode: 'string' }),
}).existing();

export const vDailyProfit = pgView('v_daily_profit', {
  day: date('day', { mode: 'string' }),
  netProfit: bigint('net_profit', { mode: 'number' }),
  coinsSpent: bigint('coins_spent', { mode: 'number' }),
  coinsEarned: bigint('coins_earned', { mode: 'number' }),
  snipes: bigint('snipes', { mode: 'number' }),
  successes: bigint('successes', { mode: 'number' }),
  tradesClosed: bigint('trades_closed', { mode: 'number' }),
  activeTraders: bigint('active_traders', { mode: 'number' }),
}).existing();

export const mvKpiDaily = pgMaterializedView('mv_kpi_daily', {
  day: date('day', { mode: 'string' }),
  newUsers: bigint('new_users', { mode: 'number' }),
  activeUsers: bigint('active_users', { mode: 'number' }),
  netProfitCents: bigint('net_profit_cents', { mode: 'number' }),
  snipes: bigint('snipes', { mode: 'number' }),
  successes: bigint('successes', { mode: 'number' }),
  revenueCents: bigint('revenue_cents', { mode: 'number' }),
}).existing();
