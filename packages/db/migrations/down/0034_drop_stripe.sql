-- Down for 0034_drop_stripe.sql
-- Recreates the Stripe tables, columns, indexes, constraint, defaults and the
-- 0026 trigger function. STRUCTURE ONLY: the dropped data (Stripe customer,
-- subscription and price ids, and the webhook event ledger) is not
-- restorable; the columns come back NULL and the table comes back empty.

-- stripe_webhook_events (as in 0018_billing.sql) -----------------------------
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text NOT NULL,

  type            text NOT NULL,
  payload         jsonb NOT NULL,
  processed_at    timestamptz,
  error           text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stripe_webhook_events_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_webhook_events_event_id_unique ON stripe_webhook_events (event_id);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_type_idx ON stripe_webhook_events (type);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_unprocessed_idx ON stripe_webhook_events (created_at) WHERE processed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON stripe_webhook_events TO app_rw;
GRANT SELECT ON stripe_webhook_events TO app_ro;

COMMENT ON TABLE stripe_webhook_events IS 'Idempotency ledger for Stripe webhook delivery: event_id is unique so a re-delivered webhook is a no-op. processed_at null means received but not yet successfully handled (retry candidate).';
COMMENT ON COLUMN stripe_webhook_events.event_id IS 'Stripe Event.id, globally unique per Stripe account.';

-- payments -------------------------------------------------------------------
ALTER TABLE payments ALTER COLUMN provider SET DEFAULT 'stripe';
COMMENT ON COLUMN payments.provider_payment_id IS 'Stripe PaymentIntent/Invoice id (or a manual reference); unique with provider.';
COMMENT ON TABLE payment_history IS 'Append-only event trail for a payment (e.g. Stripe webhook events affecting it). Pure child of payments: CASCADE.';

-- plans (as in 0005_plans.sql) -----------------------------------------------
ALTER TABLE plans ADD COLUMN IF NOT EXISTS stripe_price_id text;
CREATE UNIQUE INDEX IF NOT EXISTS plans_stripe_price_id_unique ON plans (stripe_price_id) WHERE stripe_price_id IS NOT NULL AND deleted_at IS NULL;
COMMENT ON COLUMN plans.stripe_price_id IS 'Stripe Price id for Checkout; null for manual/lifetime/coupon-only plans not sold through Stripe.';

-- subscriptions (as in 0006_subscriptions.sql) -------------------------------
ALTER TABLE subscriptions ALTER COLUMN source SET DEFAULT 'stripe';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_id_unique ON subscriptions (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_stripe_id_matches_source;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_stripe_id_matches_source CHECK (
  (source = 'stripe') OR (stripe_subscription_id IS NULL)
);
COMMENT ON COLUMN subscriptions.source IS 'stripe = normal checkout; manual = admin-granted; coupon = coupon-activated (e.g. free_days/lifetime coupon).';
COMMENT ON COLUMN subscriptions.auto_renew IS 'Mirrors Stripe''s cancel_at_period_end inverse for stripe-sourced rows; authoritative flag for manual/coupon rows.';

-- users (as in 0025 and 0026) ------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text;
CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_id_unique ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
COMMENT ON COLUMN users.stripe_customer_id IS 'Stripe Customer id, persisted the first time this user resolves one. Null until then. Unique among non-null values; also the trial-abuse 4th vector.';

CREATE OR REPLACE FUNCTION bump_users_row_version()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (to_jsonb(NEW) - 'row_version' - 'stripe_customer_id' - 'email_normalised')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'row_version' - 'stripe_customer_id' - 'email_normalised')
  THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION bump_users_row_version() IS 'BEFORE UPDATE trigger for users only: bumps row_version unless the only column(s) that changed are billing metadata excluded here (currently just stripe_customer_id — see 0026''s header comment for why this is an exclude-list, not an allow-list of "security-relevant" columns). row_version backs every access token''s ver claim (plugins/auth.ts) — an unwarranted bump forces every live session to re-login.';
