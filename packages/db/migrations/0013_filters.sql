-- 0013_filters.sql
-- Saved search filters and their realised-return history (the opportunity
-- ranker's stats, synced from the extension so they survive reinstalls).

CREATE TABLE saved_filters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name          text NOT NULL,
  filter        jsonb NOT NULL,
  filter_hash   text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    smallint NOT NULL DEFAULT 0,

  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  CONSTRAINT saved_filters_filter_is_object CHECK (jsonb_typeof(filter) = 'object')
);

CREATE UNIQUE INDEX saved_filters_user_filter_hash_unique_live ON saved_filters (user_id, filter_hash) WHERE deleted_at IS NULL;
CREATE INDEX saved_filters_user_id_idx ON saved_filters (user_id, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX saved_filters_is_active_idx ON saved_filters (user_id) WHERE deleted_at IS NULL AND is_active;
CREATE INDEX saved_filters_filter_gin ON saved_filters USING gin (filter);

CREATE TRIGGER trg_saved_filters_set_updated_at
  BEFORE UPDATE ON saved_filters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_saved_filters_bump_row_version
  BEFORE UPDATE ON saved_filters
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_filters TO app_rw;
GRANT SELECT ON saved_filters TO app_ro;

COMMENT ON TABLE saved_filters IS 'User-defined search filters, synced from the extension. Pure child of users: CASCADE on user delete.';
COMMENT ON COLUMN saved_filters.filter_hash IS 'Stable hash of `filter`, unique per user among live rows; correlates with search_activity.filter_hash and filter_stats.';

-- ---------------------------------------------------------------------------

CREATE TABLE filter_stats (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filter_id         uuid NOT NULL REFERENCES saved_filters(id) ON DELETE CASCADE,

  window_start      timestamptz NOT NULL,
  searches          integer NOT NULL DEFAULT 0,
  attempts          integer NOT NULL DEFAULT 0,
  successes         integer NOT NULL DEFAULT 0,
  coins_spent       bigint NOT NULL DEFAULT 0,
  coins_earned      bigint NOT NULL DEFAULT 0,
  coins_per_hour    numeric(14, 2) NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 0,

  CONSTRAINT filter_stats_searches_nonneg CHECK (searches >= 0),
  CONSTRAINT filter_stats_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT filter_stats_successes_nonneg CHECK (successes >= 0 AND successes <= attempts),
  CONSTRAINT filter_stats_coins_spent_nonneg CHECK (coins_spent >= 0),
  CONSTRAINT filter_stats_coins_earned_nonneg CHECK (coins_earned >= 0)
);

CREATE UNIQUE INDEX filter_stats_filter_window_unique ON filter_stats (filter_id, window_start);
CREATE INDEX filter_stats_filter_id_idx ON filter_stats (filter_id, window_start DESC);
CREATE INDEX filter_stats_coins_per_hour_idx ON filter_stats (coins_per_hour DESC);

CREATE TRIGGER trg_filter_stats_set_updated_at
  BEFORE UPDATE ON filter_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_filter_stats_bump_row_version
  BEFORE UPDATE ON filter_stats
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON filter_stats TO app_rw;
GRANT SELECT ON filter_stats TO app_ro;

COMMENT ON TABLE filter_stats IS 'Realised-return history per saved filter per rolling window, synced from the extension''s opportunity ranker. Drives filter rotation/retirement (engine/ranker.ts). Pure child of saved_filters: CASCADE.';
COMMENT ON COLUMN filter_stats.window_start IS 'Start of the aggregation window (e.g. hourly bucket); unique with filter_id.';
COMMENT ON COLUMN filter_stats.coins_per_hour IS 'Realised coins/hour for this filter in this window; the ranker''s primary scoring signal.';
