-- 0008_devices.sql

CREATE TABLE devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  license_id          uuid REFERENCES licenses(id) ON DELETE SET NULL,

  fingerprint_hash    text NOT NULL,
  name                text,
  browser             text,
  os                  text,
  extension_version   text,

  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_ip             inet,

  status              device_status NOT NULL DEFAULT 'active',
  trusted_at          timestamptz,

  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         integer NOT NULL DEFAULT 0,

  CONSTRAINT devices_last_seen_after_first CHECK (last_seen_at >= first_seen_at)
);

-- A device fingerprint identifies one browser install for one user; re-registering
-- the same fingerprint after a soft-delete is allowed (partial unique index).
CREATE UNIQUE INDEX devices_user_fingerprint_unique_live ON devices (user_id, fingerprint_hash) WHERE deleted_at IS NULL;
CREATE INDEX devices_user_id_idx ON devices (user_id) WHERE deleted_at IS NULL;
CREATE INDEX devices_license_id_idx ON devices (license_id) WHERE deleted_at IS NULL;
CREATE INDEX devices_status_idx ON devices (status) WHERE deleted_at IS NULL;
CREATE INDEX devices_last_seen_at_idx ON devices (last_seen_at);

CREATE TRIGGER trg_devices_set_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_devices_bump_row_version
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON devices TO app_rw;
GRANT SELECT ON devices TO app_ro;

COMMENT ON TABLE devices IS 'Registered browser installs for device-limit enforcement. Pure child of users: CASCADE on user delete. license_id is an optional pointer to the license currently validating this device (SET NULL if that license is removed).';
COMMENT ON COLUMN devices.fingerprint_hash IS 'Hash of a stable client-side fingerprint (never raw fingerprinting data at rest).';
COMMENT ON COLUMN devices.status IS 'active/revoked; revoked devices fail bootstrap/heartbeat validation.';
COMMENT ON COLUMN devices.trusted_at IS 'Set when a device passes additional verification (e.g. email-confirmed new device); reserved for future step-up flows.';
