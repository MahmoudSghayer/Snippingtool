-- 0021_feature_system.sql

CREATE TABLE feature_toggles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  key               text NOT NULL,
  enabled           boolean NOT NULL DEFAULT false,
  rollout_percent   smallint NOT NULL DEFAULT 100,
  plan_gate         text[] NOT NULL DEFAULT '{}',
  user_allowlist    uuid[] NOT NULL DEFAULT '{}',

  description       text,
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 0,

  CONSTRAINT feature_toggles_rollout_percent_range CHECK (rollout_percent BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX feature_toggles_key_unique ON feature_toggles (key);
CREATE INDEX feature_toggles_enabled_idx ON feature_toggles (enabled);

CREATE TRIGGER trg_feature_toggles_set_updated_at
  BEFORE UPDATE ON feature_toggles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_feature_toggles_bump_row_version
  BEFORE UPDATE ON feature_toggles
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON feature_toggles TO app_rw;
GRANT SELECT ON feature_toggles TO app_ro;

COMMENT ON TABLE feature_toggles IS 'Server-controlled feature flags read by both the API and the extension (bootstrap/heartbeat), e.g. automation.enabled, kill_switch, telemetry.enabled, trial.enabled, hibp_check.';
COMMENT ON COLUMN feature_toggles.key IS 'Dotted machine key, e.g. "automation.enabled", "kill_switch".';
COMMENT ON COLUMN feature_toggles.rollout_percent IS 'Percentage of eligible users (post plan_gate/user_allowlist) the flag is enabled for, via a stable hash of user_id; 100 = everyone.';
COMMENT ON COLUMN feature_toggles.plan_gate IS 'Plan codes this flag applies to; empty means all plans.';
COMMENT ON COLUMN feature_toggles.user_allowlist IS 'Explicit user ids the flag is force-enabled for regardless of rollout_percent.';

-- ---------------------------------------------------------------------------

CREATE TABLE system_config (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  key           text NOT NULL,
  value         jsonb NOT NULL,
  is_secret     boolean NOT NULL DEFAULT false,
  description   text,

  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX system_config_key_unique ON system_config (key);

CREATE TRIGGER trg_system_config_set_updated_at
  BEFORE UPDATE ON system_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_system_config_bump_row_version
  BEFORE UPDATE ON system_config
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON system_config TO app_rw;
GRANT SELECT ON system_config TO app_ro;

COMMENT ON TABLE system_config IS 'Admin-tunable runtime configuration: safety-governor defaults (max_actions_per_hour, max_session_minutes, max_buy_search_ratio, max_coin_flow_per_hour), device_limits, offline_grace_hours, heartbeat_minutes, etc. Value shape is key-specific, validated at the app layer.';
COMMENT ON COLUMN system_config.value IS 'JSON value for this key; can be a scalar, array or object depending on the key.';
COMMENT ON COLUMN system_config.is_secret IS 'When true, the admin UI masks the value and only privileged roles may read it unredacted (enforced at the app layer, not by column-level GRANT, since app_rw needs full read access to operate).';
