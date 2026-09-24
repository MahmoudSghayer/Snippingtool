-- 0031_payment_claims.sql
-- Payments move from Stripe (not available in the operator's region) to a
-- PayPal.me link. A PayPal.me payment carries no order data and sends no
-- webhook, so nothing in this system can know that a payment happened. The
-- buyer tells us: they submit the PayPal transaction ID and the plan they
-- paid for, and an admin checks it against the PayPal account and approves
-- or rejects it. Approval is what issues the pass.
--
-- Also: the plan catalogue is repriced as passes (Monthly / Monthly + Mobile
-- / Season), and users record which version of the Terms they accepted.

CREATE TYPE payment_claim_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE payment_claims (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_code               text NOT NULL,
  -- What the buyer says they paid, so the reviewer can compare it with the
  -- amount PayPal shows without looking the plan price up.
  amount_cents            integer NOT NULL CHECK (amount_cents > 0),
  currency                text NOT NULL DEFAULT 'usd',
  paypal_transaction_id   text NOT NULL,
  note                    text,

  status                  payment_claim_status NOT NULL DEFAULT 'pending',
  reviewed_by_admin_id    uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at             timestamptz,
  reject_reason           text,
  subscription_id         uuid REFERENCES subscriptions(id) ON DELETE SET NULL,

  deleted_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  row_version             integer NOT NULL DEFAULT 0,

  CONSTRAINT payment_claims_reviewed_consistent CHECK (
    (status = 'pending') = (reviewed_at IS NULL)
  ),
  CONSTRAINT payment_claims_reject_reason_only_when_rejected CHECK (
    reject_reason IS NULL OR status = 'rejected'
  )
);

-- One transaction ID pays for one pass. Without this, the same PayPal
-- payment could be submitted from two accounts, or twice from one.
CREATE UNIQUE INDEX payment_claims_paypal_transaction_id_unique
  ON payment_claims (upper(paypal_transaction_id)) WHERE deleted_at IS NULL;
CREATE INDEX payment_claims_status_idx ON payment_claims (status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX payment_claims_user_id_idx ON payment_claims (user_id, created_at) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_payment_claims_set_updated_at
  BEFORE UPDATE ON payment_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payment_claims_bump_row_version
  BEFORE UPDATE ON payment_claims
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_claims TO app_rw;
GRANT SELECT ON payment_claims TO app_ro;

COMMENT ON TABLE payment_claims IS 'A buyer''s statement that they paid via PayPal.me, reviewed by an admin. Approval creates or extends the subscription (subscription_id).';

-- Terms acceptance --------------------------------------------------------
ALTER TABLE users
  ADD COLUMN terms_version smallint,
  ADD COLUMN terms_accepted_at timestamptz;

COMMENT ON COLUMN users.terms_version IS 'Version of docs/legal/terms.md the user last accepted (TERMS_VERSION in @sl/shared). NULL for accounts created before terms existed.';

-- Plan catalogue: passes --------------------------------------------------
-- The codes stay (every package keys behaviour off them); what they are sold
-- as changes. Automation is in every paid plan; the difference between plans
-- is the mobile companion and how long the pass lasts.
UPDATE plans SET
  name = 'Monthly',
  description = '30-day pass. Recorder, ranking, session P&L and the autobuyer.',
  price_cents = 999,
  interval = 'month',
  is_lifetime = false,
  features = '{"ranker": true, "assist": true, "automation": true, "mobile": false}',
  sort_order = 1
WHERE code = 'pro' AND deleted_at IS NULL;

UPDATE plans SET
  name = 'Monthly + Mobile',
  description = '30-day pass. Everything in Monthly, plus Telegram and Discord remote alerts and control.',
  price_cents = 1399,
  interval = 'month',
  is_lifetime = false,
  features = '{"ranker": true, "assist": true, "automation": true, "mobile": true}',
  sort_order = 2
WHERE code = 'ultimate' AND deleted_at IS NULL;

UPDATE plans SET
  name = 'Season',
  description = 'Valid until the next EA SPORTS FC release. Everything in Monthly + Mobile.',
  price_cents = 2499,
  interval = 'one_time',
  features = '{"ranker": true, "assist": true, "automation": true, "mobile": true}',
  sort_order = 3
WHERE code = 'lifetime' AND deleted_at IS NULL;

-- Basic is retired: it was the plan without automation, and there is no such
-- plan any more. Existing basic subscriptions keep working until they end.
UPDATE plans SET is_active = false WHERE code = 'basic' AND deleted_at IS NULL;
