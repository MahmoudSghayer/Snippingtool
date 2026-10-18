-- 0039_user_bot_settings.sql
--
-- The Nova AI bot's settings (search delay, breaks, thresholds, auto-sell,
-- safety limits), per account instead of per browser:
-- `GET`/`PUT /api/v1/extension/bot-settings` read and replace them, so a
-- browser the trader signs in on (another PC, a cloud machine) starts with
-- the settings they already chose. The extension keeps a local copy for
-- when the API cannot be reached.
--
-- Its own table, not a key in `user_settings.settings`, for the same
-- reasons as user_recent_searches (0037): the settings PUT rebuilds that
-- document from its known sections, snapshots every change into
-- `settings_history` and bumps the sync `version`.
CREATE TABLE user_bot_settings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  settings      jsonb NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  -- The API validates the document (@sl/shared botSettingsSchema); the DB
  -- only holds it to its shape.
  CONSTRAINT user_bot_settings_settings_is_object CHECK (jsonb_typeof(settings) = 'object')
);

CREATE TRIGGER trg_user_bot_settings_set_updated_at
  BEFORE UPDATE ON user_bot_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_bot_settings_bump_row_version
  BEFORE UPDATE ON user_bot_settings
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON user_bot_settings TO app_rw;
GRANT SELECT ON user_bot_settings TO app_ro;

COMMENT ON TABLE user_bot_settings IS 'The Nova AI bot''s settings document, replaced whole by PUT /extension/bot-settings. One row per user (CASCADE on delete), created on the first save.';
