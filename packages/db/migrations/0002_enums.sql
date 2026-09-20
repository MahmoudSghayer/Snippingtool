-- 0002_enums.sql
-- All enum types used across the schema, created up front so later migrations
-- can reference them freely regardless of table creation order.

CREATE TYPE user_status AS ENUM ('active', 'suspended', 'banned', 'deleted');
CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE admin_role AS ENUM ('super_admin', 'support', 'analyst', 'billing');

CREATE TYPE subscription_status AS ENUM (
  'trialing', 'active', 'past_due', 'canceled', 'suspended', 'expired', 'lifetime'
);
CREATE TYPE subscription_source AS ENUM ('stripe', 'manual', 'coupon');

CREATE TYPE license_status AS ENUM ('active', 'revoked', 'expired');
CREATE TYPE device_status AS ENUM ('active', 'revoked');

CREATE TYPE user_activity_type AS ENUM (
  'login', 'logout', 'search', 'filter_change', 'settings_change', 'error',
  'heartbeat', 'device_registered', 'device_revoked', 'password_changed',
  'email_changed', 'mfa_enabled', 'mfa_disabled', 'kill_switch_triggered', 'other'
);

CREATE TYPE sniping_outcome AS ENUM (
  'attempted', 'success', 'failed', 'too_slow', 'blocked', 'error'
);

CREATE TYPE trade_status AS ENUM ('bought', 'listed', 'sold', 'expired', 'unsold');

CREATE TYPE risk_event_kind AS ENUM (
  'actions_per_hour', 'session_length', 'buy_search_ratio', 'coin_flow',
  'hard_stop', 'kill_switch'
);

CREATE TYPE notification_channel AS ENUM ('in_app', 'email', 'push', 'ws');

CREATE TYPE payment_provider AS ENUM ('stripe', 'manual');
CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'disputed');

CREATE TYPE coupon_type AS ENUM ('percent', 'fixed', 'free_days', 'lifetime');

CREATE TYPE ban_type AS ENUM ('account', 'ip', 'device', 'hwid');

CREATE TYPE flag_kind AS ENUM (
  'trial_abuse', 'multi_account', 'velocity', 'chargeback', 'suspicious_ip'
);
CREATE TYPE flag_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE flag_status AS ENUM ('open', 'reviewed', 'dismissed');

CREATE TYPE audit_actor_type AS ENUM ('user', 'admin', 'system');

COMMENT ON TYPE user_status IS 'Lifecycle state of a user account.';
COMMENT ON TYPE user_role IS 'Coarse authorization role; fine-grained admin permissions live in admin_users.permissions.';
COMMENT ON TYPE admin_role IS 'Admin panel role, gates the admin permission matrix (packages/shared/permissions.ts).';
COMMENT ON TYPE subscription_status IS 'Entitlement state machine for a subscription.';
COMMENT ON TYPE subscription_source IS 'How a subscription was created/is managed.';
COMMENT ON TYPE license_status IS 'State of an issued license key.';
COMMENT ON TYPE device_status IS 'State of a registered device/browser install.';
COMMENT ON TYPE user_activity_type IS 'Discriminator for user_activity.metadata shape.';
COMMENT ON TYPE sniping_outcome IS 'Result of a single snipe attempt.';
COMMENT ON TYPE trade_status IS 'Lifecycle of a tracked trade (bought item through resale).';
COMMENT ON TYPE risk_event_kind IS 'Which safety-governor budget produced a risk_budget_events row.';
COMMENT ON TYPE notification_channel IS 'Delivery channel recorded on notifications.delivered_via.';
COMMENT ON TYPE payment_provider IS 'Payment processor/source of truth for a payment row.';
COMMENT ON TYPE payment_status IS 'State of a payment.';
COMMENT ON TYPE coupon_type IS 'How coupon.value is interpreted.';
COMMENT ON TYPE ban_type IS 'What a ban row targets.';
COMMENT ON TYPE flag_kind IS 'Category of abuse/fraud flag raised by the abuse-detection job or an admin.';
COMMENT ON TYPE flag_severity IS 'Severity of a flag, drives admin queue triage order.';
COMMENT ON TYPE flag_status IS 'Review state of a flag.';
COMMENT ON TYPE audit_actor_type IS 'Who performed the audited action.';
