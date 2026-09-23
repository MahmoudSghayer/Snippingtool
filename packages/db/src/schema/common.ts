// Shared column helpers and enum definitions used across every domain schema
// file. Keeping these in one place means the Drizzle enum names/values stay
// byte-for-byte in sync with the CREATE TYPE statements in
// migrations/0002_enums.sql — Drizzle here is a typed query layer over
// hand-written SQL migrations, not the source of truth for DDL (see
// src/index.ts and docs/02-database.md "Why Drizzle is query-only").

import { customType, pgEnum, timestamp, uuid, integer } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// citext: case-insensitive text (users.email). Postgres returns/accepts plain
// strings over the wire for citext, so this is a thin passthrough customType
// that just labels the SQL type correctly for migrations/introspection.
// ---------------------------------------------------------------------------
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

// ---------------------------------------------------------------------------
// Reusable column presets matching the conventions in every migration:
// timestamptz, soft delete, created_at/updated_at, row_version.
// ---------------------------------------------------------------------------

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const idPk = () => uuid('id').primaryKey().defaultRandom();

export const createdAt = () => timestamptz('created_at').notNull().defaultNow();
export const updatedAt = () => timestamptz('updated_at').notNull().defaultNow();
export const deletedAt = () => timestamptz('deleted_at');
export const rowVersion = () => integer('row_version').notNull().default(0);

// ---------------------------------------------------------------------------
// Enums — names and value lists must match migrations/0002_enums.sql exactly.
// ---------------------------------------------------------------------------

export const userStatusEnum = pgEnum('user_status', ['active', 'suspended', 'banned', 'deleted']);

// --- Market intelligence (migrations/0027_market_intelligence.sql) ---------
// `first_party` is the extension's own pooled observations (docs/14 Phase F);
// it shares this enum rather than bypassing it so cross-source agreement
// checks treat it as just another opinion to reconcile.
export const marketSourceEnum = pgEnum('market_source', [
  'futbin',
  'futgg',
  'futwiz',
  'ea',
  'first_party',
]);
export const marketPlatformEnum = pgEnum('market_platform', ['console', 'pc']);
export const priceKindEnum = pgEnum('price_kind', [
  'lowest_bin',
  'range_min',
  'range_max',
  'average',
]);
export const newsKindEnum = pgEnum('news_kind', ['news', 'pitch_notes']);
export const signalDirectionEnum = pgEnum('signal_direction', ['up', 'down', 'unclear']);
// Buckets, not percentages: an article says "buffed", not "-14%". A number
// here would be false precision that later evaluation would score against.
export const signalMagnitudeEnum = pgEnum('signal_magnitude', [
  'small',
  'moderate',
  'large',
  'unclear',
]);
export const signalReviewDecisionEnum = pgEnum('signal_review_decision', [
  'accepted',
  'rejected',
  'unsure',
]);
// `content` is the honest catch-all for "EA announced something that puts
// items into the game" — promo, campaign, SBC event — without claiming to
// know which. Phase D's extraction is what narrows it.
export const marketEventKindEnum = pgEnum('market_event_kind', [
  'content',
  'season',
  'pitch_notes',
  'ratings_refresh',
  'other',
]);
export const eventDateConfidenceEnum = pgEnum('event_date_confidence', [
  'announced',
  'stated',
  'inferred',
]);

export const collectorRunStatusEnum = pgEnum('collector_run_status', [
  'running',
  'success',
  'partial',
  'failed',
  'skipped',
]);
export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);
export const adminRoleEnum = pgEnum('admin_role', ['super_admin', 'support', 'analyst', 'billing']);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'suspended',
  'expired',
  'lifetime',
]);
export const subscriptionSourceEnum = pgEnum('subscription_source', ['stripe', 'manual', 'coupon']);

export const licenseStatusEnum = pgEnum('license_status', ['active', 'revoked', 'expired']);
export const deviceStatusEnum = pgEnum('device_status', ['active', 'revoked']);

export const userActivityTypeEnum = pgEnum('user_activity_type', [
  'login',
  'logout',
  'search',
  'filter_change',
  'settings_change',
  'error',
  'heartbeat',
  'device_registered',
  'device_revoked',
  'password_changed',
  'email_changed',
  'mfa_enabled',
  'mfa_disabled',
  'kill_switch_triggered',
  'other',
]);

export const snipingOutcomeEnum = pgEnum('sniping_outcome', [
  'attempted',
  'success',
  'failed',
  'too_slow',
  'blocked',
  'error',
]);

export const tradeStatusEnum = pgEnum('trade_status', [
  'bought',
  'listed',
  'sold',
  'expired',
  'unsold',
]);

export const riskEventKindEnum = pgEnum('risk_event_kind', [
  'actions_per_hour',
  'session_length',
  'buy_search_ratio',
  'coin_flow',
  'hard_stop',
  'kill_switch',
]);

export const notificationChannelEnum = pgEnum('notification_channel', [
  'in_app',
  'email',
  'push',
  'ws',
]);

export const paymentProviderEnum = pgEnum('payment_provider', ['stripe', 'manual']);
export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'succeeded',
  'failed',
  'refunded',
  'disputed',
]);

export const couponTypeEnum = pgEnum('coupon_type', ['percent', 'fixed', 'free_days', 'lifetime']);

export const banTypeEnum = pgEnum('ban_type', ['account', 'ip', 'device', 'hwid']);

export const flagKindEnum = pgEnum('flag_kind', [
  'trial_abuse',
  'multi_account',
  'velocity',
  'chargeback',
  'suspicious_ip',
]);
export const flagSeverityEnum = pgEnum('flag_severity', ['low', 'medium', 'high', 'critical']);
export const flagStatusEnum = pgEnum('flag_status', ['open', 'reviewed', 'dismissed']);

export const auditActorTypeEnum = pgEnum('audit_actor_type', ['user', 'admin', 'system']);
