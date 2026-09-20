-- 0003_users.sql
-- Core account table. Everything else hangs off users.id.

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  email               citext NOT NULL,
  password_hash       text NOT NULL,
  email_verified_at   timestamptz,

  status              user_status NOT NULL DEFAULT 'active',
  role                user_role NOT NULL DEFAULT 'user',

  -- TOTP secret is stored symmetrically encrypted at rest (pgp_sym_encrypt,
  -- key supplied by the app from env, never stored in the DB). totp_enabled_at
  -- is null until the user completes enrolment (secret generated but unverified
  -- doesn't count as enabled).
  totp_secret_enc     bytea,
  totp_enabled_at     timestamptz,

  failed_login_count  smallint NOT NULL DEFAULT 0,
  locked_until        timestamptz,

  last_login_at       timestamptz,
  last_ip             inet,

  timezone            text NOT NULL DEFAULT 'UTC',
  referral_code       text,

  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         integer NOT NULL DEFAULT 0,

  CONSTRAINT users_failed_login_count_nonneg CHECK (failed_login_count >= 0),
  CONSTRAINT users_referral_code_format CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z0-9]{4,16}$')
);

-- Case-insensitive uniqueness on email, but only among live rows: a soft-deleted
-- user's email can be reused by a new registration.
CREATE UNIQUE INDEX users_email_unique_live ON users (email) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX users_referral_code_unique_live ON users (referral_code) WHERE deleted_at IS NULL AND referral_code IS NOT NULL;

CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;
CREATE INDEX users_role_idx ON users (role) WHERE deleted_at IS NULL;
CREATE INDEX users_created_at_idx ON users (created_at);
CREATE INDEX users_last_login_at_idx ON users (last_login_at) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_users_bump_row_version
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app_rw;
GRANT SELECT ON users TO app_ro;

COMMENT ON TABLE users IS 'End-user accounts. Soft-deleted via deleted_at; email uniqueness is enforced only among live rows.';
COMMENT ON COLUMN users.email IS 'Case-insensitive (citext). Unique among non-deleted rows.';
COMMENT ON COLUMN users.password_hash IS 'argon2id hash. Never the plaintext or a reversible encoding.';
COMMENT ON COLUMN users.email_verified_at IS 'Null until the user completes email verification; login may be gated on this (configurable).';
COMMENT ON COLUMN users.status IS 'active/suspended/banned/deleted account lifecycle state, independent of subscription status.';
COMMENT ON COLUMN users.role IS 'Coarse role. Admin-specific data (admin_role, permissions) lives in admin_users, one row per admin user.';
COMMENT ON COLUMN users.totp_secret_enc IS 'pgp_sym_encrypt-ed TOTP secret; decrypted only in the API process with a key from env, never returned to clients.';
COMMENT ON COLUMN users.totp_enabled_at IS 'Set when the user confirms TOTP enrolment with a valid code; null means 2FA is off even if a secret has been generated.';
COMMENT ON COLUMN users.failed_login_count IS 'Consecutive failed login attempts; reset to 0 on success. Drives the lockout policy together with locked_until.';
COMMENT ON COLUMN users.locked_until IS 'Login is rejected with ACCOUNT_LOCKED while now() < locked_until.';
COMMENT ON COLUMN users.last_ip IS 'IP of the most recent successful login, used for impossible-travel / IP monitoring.';
COMMENT ON COLUMN users.referral_code IS 'Optional unique code this user can share; format enforced by CHECK, uniqueness among live rows only.';
COMMENT ON COLUMN users.row_version IS 'Optimistic concurrency token, incremented by trigger on every UPDATE.';
