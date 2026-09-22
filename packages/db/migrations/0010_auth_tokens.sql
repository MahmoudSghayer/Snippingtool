-- 0010_auth_tokens.sql
-- Short-lived, single-use tokens for email verification, password reset, and
-- TOTP recovery codes. All pure children of users: CASCADE on user delete.

CREATE TABLE email_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  token_hash    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT email_verifications_expires_after_created CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX email_verifications_token_hash_unique ON email_verifications (token_hash);
CREATE INDEX email_verifications_user_id_idx ON email_verifications (user_id) WHERE consumed_at IS NULL;
CREATE INDEX email_verifications_expires_at_idx ON email_verifications (expires_at) WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON email_verifications TO app_rw;
GRANT SELECT ON email_verifications TO app_ro;

COMMENT ON TABLE email_verifications IS 'Single-use email verification tokens, 24h TTL. Only the hash is stored.';
COMMENT ON COLUMN email_verifications.consumed_at IS 'Set on first successful use; a consumed or expired token is rejected.';

-- ---------------------------------------------------------------------------

CREATE TABLE password_resets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  token_hash    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,

  requested_ip  inet,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT password_resets_expires_after_created CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX password_resets_token_hash_unique ON password_resets (token_hash);
CREATE INDEX password_resets_user_id_idx ON password_resets (user_id) WHERE consumed_at IS NULL;
CREATE INDEX password_resets_expires_at_idx ON password_resets (expires_at) WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO app_rw;
GRANT SELECT ON password_resets TO app_ro;

COMMENT ON TABLE password_resets IS 'Single-use password reset tokens, 1h TTL. Consuming one successfully revokes all of the user''s sessions (enforced at the app layer).';

-- ---------------------------------------------------------------------------

CREATE TABLE totp_recovery_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  code_hash     text NOT NULL,
  used_at       timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX totp_recovery_codes_code_hash_unique ON totp_recovery_codes (code_hash);
CREATE INDEX totp_recovery_codes_user_id_idx ON totp_recovery_codes (user_id) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON totp_recovery_codes TO app_rw;
GRANT SELECT ON totp_recovery_codes TO app_ro;

COMMENT ON TABLE totp_recovery_codes IS 'One-time TOTP recovery codes; 10 generated per user on 2FA enrolment, each usable once.';
