-- 0017_coupons.sql
-- Created before billing (0018) because payments.coupon_id references coupons.

CREATE TABLE coupons (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  code                text NOT NULL,
  type                coupon_type NOT NULL,
  value               integer NOT NULL,
  plan_ids            uuid[] NOT NULL DEFAULT '{}',

  max_redemptions     integer,
  redeemed_count      integer NOT NULL DEFAULT 0,
  expires_at          timestamptz,

  is_active           boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  row_version         integer NOT NULL DEFAULT 0,

  CONSTRAINT coupons_redeemed_count_nonneg CHECK (redeemed_count >= 0),
  CONSTRAINT coupons_max_redemptions_positive CHECK (max_redemptions IS NULL OR max_redemptions >= 1),
  CONSTRAINT coupons_redeemed_within_max CHECK (max_redemptions IS NULL OR redeemed_count <= max_redemptions),
  -- value ranges per type: percent in (0,100], fixed/free_days >= 1, lifetime's
  -- value is unused (grants a lifetime plan outright) and must be 0.
  CONSTRAINT coupons_value_range_per_type CHECK (
    (type = 'percent' AND value > 0 AND value <= 100) OR
    (type = 'fixed' AND value >= 1) OR
    (type = 'free_days' AND value >= 1) OR
    (type = 'lifetime' AND value = 0)
  )
);

CREATE UNIQUE INDEX coupons_code_unique_live ON coupons (code) WHERE deleted_at IS NULL;
CREATE INDEX coupons_is_active_idx ON coupons (is_active) WHERE deleted_at IS NULL;
CREATE INDEX coupons_expires_at_idx ON coupons (expires_at) WHERE deleted_at IS NULL AND is_active;

CREATE TRIGGER trg_coupons_set_updated_at
  BEFORE UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_coupons_bump_row_version
  BEFORE UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON coupons TO app_rw;
GRANT SELECT ON coupons TO app_ro;

COMMENT ON TABLE coupons IS 'Discount/promo codes. value is interpreted per type (percent 1-100, fixed cents >=1, free_days >=1, lifetime unused=0), enforced by CHECK.';
COMMENT ON COLUMN coupons.plan_ids IS 'Plans this coupon applies to; empty array means all plans.';
COMMENT ON COLUMN coupons.value IS 'percent: 1-100 (%). fixed: cents off. free_days: number of free days granted. lifetime: unused, must be 0 (coupon grants a lifetime plan outright).';
COMMENT ON COLUMN coupons.created_by IS 'Optional actor (admin); SET NULL if that admin''s user row is removed — the coupon itself is retained.';

-- ---------------------------------------------------------------------------

CREATE TABLE coupon_redemptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  coupon_id         uuid NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id   uuid REFERENCES subscriptions(id) ON DELETE SET NULL,

  redeemed_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One redemption per coupon per user (coupons are not stackable/repeatable per user).
CREATE UNIQUE INDEX coupon_redemptions_coupon_user_unique ON coupon_redemptions (coupon_id, user_id);
CREATE INDEX coupon_redemptions_coupon_id_idx ON coupon_redemptions (coupon_id);
CREATE INDEX coupon_redemptions_user_id_idx ON coupon_redemptions (user_id);
CREATE INDEX coupon_redemptions_subscription_id_idx ON coupon_redemptions (subscription_id);

GRANT SELECT, INSERT ON coupon_redemptions TO app_rw;
GRANT SELECT ON coupon_redemptions TO app_ro;

COMMENT ON TABLE coupon_redemptions IS 'Append-only record of a coupon being redeemed by a user. Financial record: RESTRICT on coupon_id/user_id. subscription_id is SET NULL if the granted subscription row is later removed, since the redemption event itself must be retained.';
