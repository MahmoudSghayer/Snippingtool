-- 0034_drop_stripe.sql
--
-- Stripe is gone. Payments are PayPal.me claims that an admin approves
-- (0031_payment_claims.sql); nothing in the codebase talks to Stripe any
-- more, so its tables and columns are dropped here:
--
--   - stripe_webhook_events              (webhook idempotency ledger, 0018)
--   - users.stripe_customer_id           (+ users_stripe_customer_id_unique, 0025)
--   - subscriptions.stripe_subscription_id
--                                        (+ subscriptions_stripe_subscription_id_unique
--                                         and CHECK subscriptions_stripe_id_matches_source, 0006)
--   - plans.stripe_price_id              (+ plans_stripe_price_id_unique, 0005)
--
-- Defaults that pointed at Stripe move to 'manual':
--   subscriptions.source and payments.provider. Every insert in the app
-- sets these explicitly already; this only changes what a bare insert gets.
--
-- The enum label 'stripe' stays in the subscription_source and
-- payment_provider types. Postgres cannot drop an enum label without
-- recreating the type (and the analytics views and CHECK constraints that
-- depend on subscriptions.source), and any historical rows that carry the
-- label must keep a valid value. No code writes it any more.
--
-- bump_users_row_version() (0026) listed stripe_customer_id among the
-- columns that do not bump users.row_version; with the column gone, it is
-- recreated with only the email_normalised exclusion.
--
-- DEPLOY ORDER: the API before this change selects these columns by name
-- (Drizzle lists every column of users, plans and subscriptions), so it
-- fails as soon as they are dropped. Deploy the code that no longer uses
-- them first, and apply this migration in a later deploy. The new code runs
-- fine with or without the columns.

-- users ---------------------------------------------------------------------
DROP INDEX IF EXISTS users_stripe_customer_id_unique;
ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;

CREATE OR REPLACE FUNCTION bump_users_row_version()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- `email_normalised` (0025) is a GENERATED ALWAYS ... STORED column; its
  -- value in NEW is unspecified inside a BEFORE ROW trigger (it reads NULL),
  -- so comparing it would make every UPDATE look like a change. It only
  -- ever changes when email does, and email is still compared.
  IF (to_jsonb(NEW) - 'row_version' - 'email_normalised')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'row_version' - 'email_normalised')
  THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION bump_users_row_version() IS 'BEFORE UPDATE trigger for users only: bumps row_version on any change except to the generated email_normalised column (see 0026 and 0034). row_version backs every access token''s ver claim (plugins/auth.ts) — an unwarranted bump forces every live session to re-login.';

-- subscriptions -------------------------------------------------------------
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_stripe_id_matches_source;
DROP INDEX IF EXISTS subscriptions_stripe_subscription_id_unique;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS stripe_subscription_id;
ALTER TABLE subscriptions ALTER COLUMN source SET DEFAULT 'manual';

COMMENT ON COLUMN subscriptions.source IS 'manual = admin-granted or issued by approving a PayPal payment claim (and trials); coupon = coupon-activated. The legacy ''stripe'' label is no longer written (0034).';
COMMENT ON COLUMN subscriptions.auto_renew IS 'Authoritative renew flag. Nothing renews a subscription automatically since Stripe was removed (0034); a new pass comes from an approved payment claim or an admin grant.';

-- plans ---------------------------------------------------------------------
DROP INDEX IF EXISTS plans_stripe_price_id_unique;
ALTER TABLE plans DROP COLUMN IF EXISTS stripe_price_id;

-- payments ------------------------------------------------------------------
ALTER TABLE payments ALTER COLUMN provider SET DEFAULT 'manual';

COMMENT ON COLUMN payments.provider_payment_id IS 'Provider reference, unique with provider. An approved PayPal payment claim records paypal:<transaction id>.';
COMMENT ON TABLE payment_history IS 'Append-only event trail for a payment. Pure child of payments: CASCADE.';

-- stripe_webhook_events -----------------------------------------------------
DROP TABLE IF EXISTS stripe_webhook_events;
