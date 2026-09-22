-- 0018_billing.sql

CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subscription_id       uuid REFERENCES subscriptions(id) ON DELETE RESTRICT,

  provider              payment_provider NOT NULL DEFAULT 'stripe',
  provider_payment_id   text NOT NULL,

  amount_cents          integer NOT NULL,
  currency              text NOT NULL DEFAULT 'usd',
  status                payment_status NOT NULL DEFAULT 'pending',

  coupon_id             uuid REFERENCES coupons(id) ON DELETE SET NULL,
  invoice_url           text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 0,

  CONSTRAINT payments_amount_cents_nonneg CHECK (amount_cents >= 0)
);

CREATE UNIQUE INDEX payments_provider_payment_id_unique ON payments (provider, provider_payment_id);
CREATE INDEX payments_user_id_idx ON payments (user_id, created_at DESC);
CREATE INDEX payments_subscription_id_idx ON payments (subscription_id);
CREATE INDEX payments_status_idx ON payments (status);
CREATE INDEX payments_coupon_id_idx ON payments (coupon_id) WHERE coupon_id IS NOT NULL;

CREATE TRIGGER trg_payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payments_bump_row_version
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON payments TO app_rw;
GRANT SELECT ON payments TO app_ro;

COMMENT ON TABLE payments IS 'One row per payment attempt/charge. Financial record: RESTRICT on user_id/subscription_id. provider_payment_id unique per provider (idempotency for webhook-driven inserts).';
COMMENT ON COLUMN payments.provider_payment_id IS 'Stripe PaymentIntent/Invoice id (or a manual reference); unique with provider.';
COMMENT ON COLUMN payments.coupon_id IS 'Coupon applied to this payment, if any; SET NULL if the coupon is later removed (payment amount already reflects the discount).';

-- ---------------------------------------------------------------------------

CREATE TABLE payment_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,

  event         text NOT NULL,
  raw_event     jsonb NOT NULL DEFAULT '{}'::jsonb,

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_history_raw_event_is_object CHECK (jsonb_typeof(raw_event) = 'object')
);

CREATE INDEX payment_history_payment_id_idx ON payment_history (payment_id, occurred_at DESC);
CREATE INDEX payment_history_event_idx ON payment_history (event);
CREATE INDEX payment_history_raw_event_gin ON payment_history USING gin (raw_event);

GRANT SELECT, INSERT ON payment_history TO app_rw;
GRANT SELECT ON payment_history TO app_ro;

COMMENT ON TABLE payment_history IS 'Append-only event trail for a payment (e.g. Stripe webhook events affecting it). Pure child of payments: CASCADE.';
COMMENT ON COLUMN payment_history.raw_event IS 'Raw provider event payload for support/debugging/replay.';

-- ---------------------------------------------------------------------------

CREATE TABLE stripe_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text NOT NULL,

  type            text NOT NULL,
  payload         jsonb NOT NULL,
  processed_at    timestamptz,
  error           text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stripe_webhook_events_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX stripe_webhook_events_event_id_unique ON stripe_webhook_events (event_id);
CREATE INDEX stripe_webhook_events_type_idx ON stripe_webhook_events (type);
CREATE INDEX stripe_webhook_events_unprocessed_idx ON stripe_webhook_events (created_at) WHERE processed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON stripe_webhook_events TO app_rw;
GRANT SELECT ON stripe_webhook_events TO app_ro;

COMMENT ON TABLE stripe_webhook_events IS 'Idempotency ledger for Stripe webhook delivery: event_id is unique so a re-delivered webhook is a no-op. processed_at null means received but not yet successfully handled (retry candidate).';
COMMENT ON COLUMN stripe_webhook_events.event_id IS 'Stripe Event.id, globally unique per Stripe account.';
