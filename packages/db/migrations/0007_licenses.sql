-- 0007_licenses.sql

CREATE TABLE licenses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  subscription_id     uuid NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Only the hash of "SL-XXXX-XXXX-XXXX-XXXX" is stored; key_prefix (e.g. the
  -- first group "SL-XXXX") is kept in the clear for display/support lookup.
  key_hash            text NOT NULL,
  key_prefix          text NOT NULL,

  status              license_status NOT NULL DEFAULT 'active',
  max_devices         smallint NOT NULL,
  expires_at          timestamptz,

  last_validated_at   timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text,

  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  row_version         integer NOT NULL DEFAULT 0,

  CONSTRAINT licenses_max_devices_range CHECK (max_devices BETWEEN 1 AND 10),
  CONSTRAINT licenses_revoked_consistency CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX licenses_key_hash_unique ON licenses (key_hash);
CREATE INDEX licenses_subscription_id_idx ON licenses (subscription_id) WHERE deleted_at IS NULL;
CREATE INDEX licenses_user_id_idx ON licenses (user_id) WHERE deleted_at IS NULL;
CREATE INDEX licenses_status_idx ON licenses (status) WHERE deleted_at IS NULL;
CREATE INDEX licenses_expires_at_idx ON licenses (expires_at) WHERE deleted_at IS NULL AND status = 'active';
CREATE INDEX licenses_key_prefix_idx ON licenses (key_prefix);

CREATE TRIGGER trg_licenses_set_updated_at
  BEFORE UPDATE ON licenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_licenses_bump_row_version
  BEFORE UPDATE ON licenses
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON licenses TO app_rw;
GRANT SELECT ON licenses TO app_ro;

COMMENT ON TABLE licenses IS 'Issued license keys (format SL-XXXX-XXXX-XXXX-XXXX, Crockford base32 + checksum). Only a hash is persisted. RESTRICT on subscription_id/user_id: a license is a financial/entitlement record.';
COMMENT ON COLUMN licenses.key_hash IS 'argon2id (or equivalent) hash of the full key; the only way to validate a presented key is to hash and compare.';
COMMENT ON COLUMN licenses.key_prefix IS 'Non-secret display prefix (e.g. "SL-7F2K") for support/UI without exposing the full key.';
COMMENT ON COLUMN licenses.max_devices IS 'Copied from plans.device_limit at issuance so changing a plan''s default does not retroactively change already-issued licenses; 1-10 by CHECK.';
COMMENT ON COLUMN licenses.last_validated_at IS 'Updated on every successful /extension/bootstrap or heartbeat validation; drives the 24h offline grace period.';
