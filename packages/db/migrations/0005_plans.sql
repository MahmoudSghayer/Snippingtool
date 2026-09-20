-- 0005_plans.sql
-- Plans are data, not code, so admins can create new plans (including
-- one-off lifetime plans) without a deploy.

CREATE TABLE plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  code                text NOT NULL,
  name                text NOT NULL,
  description         text,

  price_cents         integer NOT NULL,
  currency            text NOT NULL DEFAULT 'usd',
  interval            text NOT NULL DEFAULT 'month',
  is_lifetime         boolean NOT NULL DEFAULT false,

  device_limit        smallint NOT NULL,
  features            jsonb NOT NULL DEFAULT '{}'::jsonb,

  stripe_price_id     text,
  is_active           boolean NOT NULL DEFAULT true,
  sort_order          smallint NOT NULL DEFAULT 0,

  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  row_version         integer NOT NULL DEFAULT 0,

  CONSTRAINT plans_price_cents_nonneg CHECK (price_cents >= 0),
  CONSTRAINT plans_device_limit_range CHECK (device_limit BETWEEN 1 AND 10),
  CONSTRAINT plans_interval_valid CHECK (interval IN ('day', 'week', 'month', 'year', 'one_time')),
  CONSTRAINT plans_features_is_object CHECK (jsonb_typeof(features) = 'object'),
  -- A lifetime plan is billed once; it cannot also declare a recurring interval.
  CONSTRAINT plans_lifetime_interval_consistency CHECK (
    (is_lifetime AND interval = 'one_time') OR (NOT is_lifetime AND interval <> 'one_time')
  )
);

CREATE UNIQUE INDEX plans_code_unique_live ON plans (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX plans_stripe_price_id_unique ON plans (stripe_price_id) WHERE stripe_price_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX plans_is_active_idx ON plans (is_active) WHERE deleted_at IS NULL;
CREATE INDEX plans_features_gin_idx ON plans USING gin (features);

CREATE TRIGGER trg_plans_set_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_plans_bump_row_version
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON plans TO app_rw;
GRANT SELECT ON plans TO app_ro;

COMMENT ON TABLE plans IS 'Subscription plan catalogue, including admin-created one-off lifetime plans. Data-driven so no deploy is needed to add a plan.';
COMMENT ON COLUMN plans.code IS 'Stable machine key, e.g. trial/basic/pro/ultimate/lifetime-founders. Unique among live rows.';
COMMENT ON COLUMN plans.price_cents IS 'Price in integer cents (avoids float rounding). 0 for the trial plan.';
COMMENT ON COLUMN plans.interval IS 'Billing interval; "one_time" for lifetime plans, enforced consistent with is_lifetime by CHECK.';
COMMENT ON COLUMN plans.device_limit IS 'Max concurrently active devices for a subscription on this plan; enforced at login/device registration. 1-10 by CHECK.';
COMMENT ON COLUMN plans.features IS 'Feature-flag object gating plan-specific capabilities, e.g. {"ranker": true, "automation": false}.';
COMMENT ON COLUMN plans.stripe_price_id IS 'Stripe Price id for Checkout; null for manual/lifetime/coupon-only plans not sold through Stripe.';
