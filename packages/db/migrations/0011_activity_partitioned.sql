-- 0011_activity_partitioned.sql
-- High-volume, append-mostly telemetry tables, declaratively range-partitioned
-- by month on occurred_at. Each gets: a DEFAULT partition (catches any row
-- outside the declared monthly ranges rather than erroring the insert), and
-- initial partitions for the current month through 12 months ahead via
-- create_month_partitions() (see 0001). Partition maintenance runbook is in
-- docs/02-database.md.
--
-- Partitioned tables require the partition key (occurred_at) in every unique
-- constraint, so the primary key here is (id, occurred_at) rather than (id).
-- Foreign keys on a partitioned table are supported natively in PG 16 and are
-- declared once on the parent.

-- ---------------------------------------------------------------------------
-- user_activity
-- ---------------------------------------------------------------------------

CREATE TABLE user_activity (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,

  type          user_activity_type NOT NULL,
  ip            inet,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_activity_pkey PRIMARY KEY (id, occurred_at),
  CONSTRAINT user_activity_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
) PARTITION BY RANGE (occurred_at);

CREATE TABLE user_activity_default PARTITION OF user_activity DEFAULT;

CREATE INDEX user_activity_user_id_idx ON user_activity (user_id, occurred_at DESC);
CREATE INDEX user_activity_device_id_idx ON user_activity (device_id, occurred_at DESC);
CREATE INDEX user_activity_type_idx ON user_activity (type, occurred_at DESC);
CREATE INDEX user_activity_occurred_at_brin ON user_activity USING brin (occurred_at);
CREATE INDEX user_activity_metadata_gin ON user_activity USING gin (metadata);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_activity TO app_rw;
GRANT SELECT ON user_activity TO app_ro;

COMMENT ON TABLE user_activity IS 'Generic user event stream (login/logout/search/filter_change/settings_change/error/heartbeat/...). Partitioned by month on occurred_at. Pure child of users: CASCADE on user delete (supports GDPR erasure).';
COMMENT ON COLUMN user_activity.type IS 'Event discriminator; metadata shape is type-specific and documented in docs/02-database.md.';
COMMENT ON COLUMN user_activity.metadata IS 'Type-specific structured payload, account-agnostic (see project trust guarantees) — never raw EA session/club/trade-history data.';

-- ---------------------------------------------------------------------------
-- search_activity
-- ---------------------------------------------------------------------------

CREATE TABLE search_activity (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,

  filter_hash   text NOT NULL,
  filter        jsonb NOT NULL,
  results_count integer NOT NULL,
  resource_id   text,
  floor_price   integer,

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT search_activity_pkey PRIMARY KEY (id, occurred_at),
  CONSTRAINT search_activity_filter_is_object CHECK (jsonb_typeof(filter) = 'object'),
  CONSTRAINT search_activity_results_count_nonneg CHECK (results_count >= 0),
  CONSTRAINT search_activity_floor_price_nonneg CHECK (floor_price IS NULL OR floor_price >= 0)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE search_activity_default PARTITION OF search_activity DEFAULT;

CREATE INDEX search_activity_user_id_idx ON search_activity (user_id, occurred_at DESC);
CREATE INDEX search_activity_device_id_idx ON search_activity (device_id, occurred_at DESC);
CREATE INDEX search_activity_filter_hash_idx ON search_activity (filter_hash, occurred_at DESC);
CREATE INDEX search_activity_resource_id_idx ON search_activity (resource_id, occurred_at DESC);
CREATE INDEX search_activity_occurred_at_brin ON search_activity USING brin (occurred_at);
CREATE INDEX search_activity_filter_gin ON search_activity USING gin (filter);

GRANT SELECT, INSERT, UPDATE, DELETE ON search_activity TO app_rw;
GRANT SELECT ON search_activity TO app_ro;

COMMENT ON TABLE search_activity IS 'Search-metadata telemetry from the extension: filter hash/shape, result count, resource searched, observed floor price. Raw market observations stay local (no market_observations table, see project trust guarantees); this is account-agnostic metadata only. Partitioned by month on occurred_at, CASCADE on user delete.';
COMMENT ON COLUMN search_activity.filter_hash IS 'Stable hash of the filter object, used to correlate with saved_filters/filter_stats without re-parsing filter jsonb.';
COMMENT ON COLUMN search_activity.resource_id IS 'EA player/item resource id the search targeted, if applicable.';

-- ---------------------------------------------------------------------------
-- sniping_activity
-- ---------------------------------------------------------------------------

CREATE TABLE sniping_activity (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,

  resource_id   text NOT NULL,
  trade_id      text,
  target_price  integer NOT NULL,
  listed_price  integer,
  outcome       sniping_outcome NOT NULL,
  latency_ms    integer,
  error_code    text,

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sniping_activity_pkey PRIMARY KEY (id, occurred_at),
  CONSTRAINT sniping_activity_target_price_nonneg CHECK (target_price >= 0),
  CONSTRAINT sniping_activity_listed_price_nonneg CHECK (listed_price IS NULL OR listed_price >= 0),
  CONSTRAINT sniping_activity_latency_nonneg CHECK (latency_ms IS NULL OR latency_ms >= 0)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE sniping_activity_default PARTITION OF sniping_activity DEFAULT;

CREATE INDEX sniping_activity_user_id_idx ON sniping_activity (user_id, occurred_at DESC);
CREATE INDEX sniping_activity_device_id_idx ON sniping_activity (device_id, occurred_at DESC);
CREATE INDEX sniping_activity_resource_id_idx ON sniping_activity (resource_id, occurred_at DESC);
CREATE INDEX sniping_activity_trade_id_idx ON sniping_activity (trade_id) WHERE trade_id IS NOT NULL;
CREATE INDEX sniping_activity_outcome_idx ON sniping_activity (outcome, occurred_at DESC);
CREATE INDEX sniping_activity_occurred_at_brin ON sniping_activity USING brin (occurred_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON sniping_activity TO app_rw;
GRANT SELECT ON sniping_activity TO app_ro;

COMMENT ON TABLE sniping_activity IS 'One row per snipe attempt outcome computed by the extension (attempt through result). Partitioned by month on occurred_at, CASCADE on user delete.';
COMMENT ON COLUMN sniping_activity.trade_id IS 'Correlates to trades.trade_id when the attempt succeeded and became a tracked trade; free-form because it is the extension-generated id, not this DB''s.';
COMMENT ON COLUMN sniping_activity.outcome IS 'attempted/success/failed/too_slow/blocked/error — blocked means the safety governor denied the action.';

-- ---------------------------------------------------------------------------
-- Initial partitions: current month through 12 months ahead (13 partitions
-- each). Extend coverage later by calling create_month_partitions again with
-- a later from_month (see docs/02-database.md runbook and the
-- subscriptions.expire-style maintenance job).
-- ---------------------------------------------------------------------------

SELECT create_month_partitions('user_activity', date_trunc('month', now())::date, 13);
SELECT create_month_partitions('search_activity', date_trunc('month', now())::date, 13);
SELECT create_month_partitions('sniping_activity', date_trunc('month', now())::date, 13);
