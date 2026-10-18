-- 0037_user_recent_searches.sql
--
-- The Nova AI page's Recent searches log, per account instead of per
-- browser: `GET`/`PUT /api/v1/extension/recent-searches` read and replace
-- it, so every browser the trader signs in on shows the same list.
--
-- Its own table, not a key in `user_settings.settings`: the settings PUT
-- rebuilds that document from its known sections, every settings change is
-- snapshotted into `settings_history` and bumps the sync `version`, and
-- bootstrap/heartbeat send the whole document every ten minutes. The log
-- changes on every bot start and needs none of that.
CREATE TABLE user_recent_searches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  items         jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  -- The API validates every entry (@sl/shared recentSearchSchema); the DB
  -- only holds the list to its shape and length.
  CONSTRAINT user_recent_searches_items_is_array CHECK (jsonb_typeof(items) = 'array'),
  CONSTRAINT user_recent_searches_items_max CHECK (jsonb_array_length(items) <= 10)
);

CREATE TRIGGER trg_user_recent_searches_set_updated_at
  BEFORE UPDATE ON user_recent_searches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_recent_searches_bump_row_version
  BEFORE UPDATE ON user_recent_searches
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON user_recent_searches TO app_rw;
GRANT SELECT ON user_recent_searches TO app_ro;

COMMENT ON TABLE user_recent_searches IS 'The Nova AI page''s Recent searches log (newest first, at most 10), replaced whole by PUT /extension/recent-searches. One row per user (CASCADE on delete), created on the first save.';
