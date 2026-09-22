-- 0015_settings.sql

CREATE TABLE user_settings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  version       integer NOT NULL DEFAULT 1,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  CONSTRAINT user_settings_settings_is_object CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT user_settings_version_positive CHECK (version >= 1)
);

CREATE INDEX user_settings_settings_gin ON user_settings USING gin (settings);

CREATE TRIGGER trg_user_settings_set_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_settings_bump_row_version
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON user_settings TO app_rw;
GRANT SELECT ON user_settings TO app_ro;

COMMENT ON TABLE user_settings IS 'Current settings blob per user (governor thresholds within admin-set bounds, telemetry opt-out, UI prefs, etc.), validated by the shared Zod schema in packages/shared. Server version wins on sync conflicts (settings.ts); local is a backup. One row per user (CASCADE on delete).';
COMMENT ON COLUMN user_settings.settings IS 'Free-form settings object; validated against packages/shared''s settings schema at the API boundary, not by the DB.';
COMMENT ON COLUMN user_settings.version IS 'Monotonic version bumped on every save; the extension compares this to decide which side wins on sync.';

-- ---------------------------------------------------------------------------

CREATE TABLE settings_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  settings      jsonb NOT NULL,
  version       integer NOT NULL,
  changed_by    uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settings_history_settings_is_object CHECK (jsonb_typeof(settings) = 'object')
);

CREATE INDEX settings_history_user_id_idx ON settings_history (user_id, created_at DESC);
CREATE UNIQUE INDEX settings_history_user_version_unique ON settings_history (user_id, version);

GRANT SELECT, INSERT ON settings_history TO app_rw;
GRANT SELECT ON settings_history TO app_ro;

COMMENT ON TABLE settings_history IS 'Append-only snapshot of user_settings on every change, for support/debugging and rollback. CASCADE on user delete; changed_by is an optional actor (could be the user themself or an admin override).';
