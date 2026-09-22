-- 0006_subscriptions.sql

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id               uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,

  status                subscription_status NOT NULL DEFAULT 'trialing',
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  trial_ends_at         timestamptz,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  auto_renew            boolean NOT NULL DEFAULT true,

  stripe_subscription_id text,
  source                subscription_source NOT NULL DEFAULT 'stripe',
  granted_by_admin_id   uuid REFERENCES admin_users(id) ON DELETE SET NULL,

  canceled_at           timestamptz,
  ended_at              timestamptz,

  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  row_version           integer NOT NULL DEFAULT 0,

  CONSTRAINT subscriptions_period_order CHECK (
    current_period_start IS NULL OR current_period_end IS NULL OR current_period_end > current_period_start
  ),
  CONSTRAINT subscriptions_trial_ends_only_when_trialing CHECK (
    trial_ends_at IS NULL OR status = 'trialing'
  ),
  -- source=manual/coupon rows are not Stripe-managed and never carry a Stripe id.
  CONSTRAINT subscriptions_stripe_id_matches_source CHECK (
    (source = 'stripe') OR (stripe_subscription_id IS NULL)
  ),
  -- lifetime status implies the admin-managed / non-stripe path.
  CONSTRAINT subscriptions_lifetime_source CHECK (
    status <> 'lifetime' OR source IN ('manual', 'coupon')
  )
);

CREATE UNIQUE INDEX subscriptions_stripe_subscription_id_unique ON subscriptions (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
-- A user may have historical (canceled/expired) subscriptions, but only one
-- "live" one (trialing/active/past_due/suspended/lifetime) at a time.
CREATE UNIQUE INDEX subscriptions_one_live_per_user ON subscriptions (user_id)
  WHERE deleted_at IS NULL AND status IN ('trialing', 'active', 'past_due', 'suspended', 'lifetime');

CREATE INDEX subscriptions_user_id_idx ON subscriptions (user_id) WHERE deleted_at IS NULL;
CREATE INDEX subscriptions_plan_id_idx ON subscriptions (plan_id) WHERE deleted_at IS NULL;
CREATE INDEX subscriptions_status_idx ON subscriptions (status) WHERE deleted_at IS NULL;
CREATE INDEX subscriptions_current_period_end_idx ON subscriptions (current_period_end) WHERE deleted_at IS NULL;
CREATE INDEX subscriptions_trial_ends_at_idx ON subscriptions (trial_ends_at) WHERE deleted_at IS NULL AND status = 'trialing';

CREATE TRIGGER trg_subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subscriptions_bump_row_version
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions TO app_rw;
GRANT SELECT ON subscriptions TO app_ro;

COMMENT ON TABLE subscriptions IS 'A user''s entitlement over time. Local state is the source of truth for entitlements; reconciled from Stripe by webhook + nightly sync. RESTRICT on user_id/plan_id: financial records are never silently orphaned.';
COMMENT ON COLUMN subscriptions.status IS 'Entitlement state machine; see subscription_status enum. Partial unique index allows only one live subscription per user.';
COMMENT ON COLUMN subscriptions.trial_ends_at IS 'Only populated while status=trialing (CHECK); cleared by the app on transition out of trial.';
COMMENT ON COLUMN subscriptions.source IS 'stripe = normal checkout; manual = admin-granted; coupon = coupon-activated (e.g. free_days/lifetime coupon).';
COMMENT ON COLUMN subscriptions.granted_by_admin_id IS 'Set when source=manual/coupon and an admin performed the grant; optional actor, SET NULL if that admin account is later removed.';
COMMENT ON COLUMN subscriptions.auto_renew IS 'Mirrors Stripe''s cancel_at_period_end inverse for stripe-sourced rows; authoritative flag for manual/coupon rows.';
