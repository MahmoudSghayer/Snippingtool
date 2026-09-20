-- 0009_sessions.sql
-- Refresh-token sessions. Access tokens are stateless JWTs (not persisted);
-- this table backs refresh-token rotation with reuse detection.

CREATE TABLE sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id             uuid REFERENCES devices(id) ON DELETE SET NULL,

  refresh_token_hash    text NOT NULL,
  family_id             uuid NOT NULL,

  ip                    inet,
  user_agent            text,

  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz,
  revoked_reason        text,
  last_used_at          timestamptz NOT NULL DEFAULT now(),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 0,

  CONSTRAINT sessions_expires_after_created CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX sessions_refresh_token_hash_unique ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_device_id_idx ON sessions (device_id);
-- Reuse detection: given a family_id, find all sibling tokens (issued/rotated
-- together) to revoke the whole family on detected reuse of a stale token.
CREATE INDEX sessions_family_id_idx ON sessions (family_id);
CREATE INDEX sessions_active_idx ON sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TRIGGER trg_sessions_set_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sessions_bump_row_version
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_rw;
GRANT SELECT ON sessions TO app_ro;

COMMENT ON TABLE sessions IS 'Opaque refresh-token sessions, one row per issued/rotated refresh token. Pure child of users: CASCADE on user delete. No soft delete (revoked_at is the terminal state; rows are pruned by a retention job).';
COMMENT ON COLUMN sessions.refresh_token_hash IS 'SHA-256 (or equivalent) hash of the 32-byte random refresh token; the raw token is never stored.';
COMMENT ON COLUMN sessions.family_id IS 'Shared across all tokens produced by rotating from the original login; a used-and-superseded token presented again ("reuse") revokes the entire family.';
COMMENT ON COLUMN sessions.device_id IS 'Device this session is bound to; optional actor reference, SET NULL if the device row is removed (session itself may still be explicitly revoked by the app).';
