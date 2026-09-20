-- 0012_trading.sql
-- Financial record tables: trades (individual buy/sell) and profits (daily
-- per-user rollup). RESTRICT on user_id — these are financial rows and must
-- never be silently orphaned by a user hard-delete.

CREATE TABLE trades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  trade_id      text NOT NULL,
  resource_id   text NOT NULL,
  asset_id      text,
  rating        smallint,

  buy_price     integer,
  sell_price    integer,
  ea_tax        integer,
  net_profit    integer,

  status        trade_status NOT NULL DEFAULT 'bought',
  bought_at     timestamptz,
  sold_at       timestamptz,

  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  CONSTRAINT trades_buy_price_nonneg CHECK (buy_price IS NULL OR buy_price >= 0),
  CONSTRAINT trades_sell_price_nonneg CHECK (sell_price IS NULL OR sell_price >= 0),
  CONSTRAINT trades_ea_tax_nonneg CHECK (ea_tax IS NULL OR ea_tax >= 0),
  CONSTRAINT trades_rating_range CHECK (rating IS NULL OR rating BETWEEN 0 AND 99),
  CONSTRAINT trades_sold_after_bought CHECK (
    bought_at IS NULL OR sold_at IS NULL OR sold_at >= bought_at
  )
);

CREATE UNIQUE INDEX trades_user_id_trade_id_unique_live ON trades (user_id, trade_id) WHERE deleted_at IS NULL;
CREATE INDEX trades_user_id_idx ON trades (user_id) WHERE deleted_at IS NULL;
CREATE INDEX trades_resource_id_idx ON trades (resource_id) WHERE deleted_at IS NULL;
CREATE INDEX trades_status_idx ON trades (status) WHERE deleted_at IS NULL;
CREATE INDEX trades_sold_at_idx ON trades (user_id, sold_at) WHERE deleted_at IS NULL AND sold_at IS NOT NULL;

CREATE TRIGGER trg_trades_set_updated_at
  BEFORE UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_trades_bump_row_version
  BEFORE UPDATE ON trades
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON trades TO app_rw;
GRANT SELECT ON trades TO app_ro;

COMMENT ON TABLE trades IS 'Individual tracked trades (bought item through resale), computed and reported by the user''s own extension. Financial record: RESTRICT on user_id.';
COMMENT ON COLUMN trades.trade_id IS 'Extension-generated identifier for the trade; unique per user among live rows.';
COMMENT ON COLUMN trades.ea_tax IS 'EA''s 5% transfer-market tax on the sale, in coins.';
COMMENT ON COLUMN trades.net_profit IS 'sell_price - buy_price - ea_tax, computed client-side and reported as-is; source of truth for profits rollups.';

-- ---------------------------------------------------------------------------

CREATE TABLE profits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  day             date NOT NULL,
  coins_spent     bigint NOT NULL DEFAULT 0,
  coins_earned    bigint NOT NULL DEFAULT 0,
  net_profit      bigint NOT NULL DEFAULT 0,
  snipes          integer NOT NULL DEFAULT 0,
  successes       integer NOT NULL DEFAULT 0,
  trades_closed   integer NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 0,

  CONSTRAINT profits_coins_spent_nonneg CHECK (coins_spent >= 0),
  CONSTRAINT profits_coins_earned_nonneg CHECK (coins_earned >= 0),
  CONSTRAINT profits_snipes_nonneg CHECK (snipes >= 0),
  CONSTRAINT profits_successes_nonneg CHECK (successes >= 0 AND successes <= snipes),
  CONSTRAINT profits_trades_closed_nonneg CHECK (trades_closed >= 0)
);

CREATE UNIQUE INDEX profits_user_id_day_unique ON profits (user_id, day);
CREATE INDEX profits_day_idx ON profits (day);
CREATE INDEX profits_user_id_idx ON profits (user_id, day DESC);

CREATE TRIGGER trg_profits_set_updated_at
  BEFORE UPDATE ON profits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_profits_bump_row_version
  BEFORE UPDATE ON profits
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON profits TO app_rw;
GRANT SELECT ON profits TO app_ro;

COMMENT ON TABLE profits IS 'Daily per-user rollup of trading activity, maintained by the profits.rollup hourly job (upsert on (user_id, day)). Financial record: RESTRICT on user_id.';
COMMENT ON COLUMN profits.day IS 'Calendar day (UTC) this rollup covers; unique with user_id.';
COMMENT ON COLUMN profits.net_profit IS 'Sum of trades.net_profit for trades closed (sold) on this day.';
