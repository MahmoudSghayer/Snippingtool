-- 0022_ip_installs.sql

CREATE TABLE ip_activity (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  ip              inet NOT NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id       uuid REFERENCES devices(id) ON DELETE SET NULL,

  country         text,
  asn             integer,

  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  request_count   bigint NOT NULL DEFAULT 1,
  flagged         boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 0,

  CONSTRAINT ip_activity_request_count_positive CHECK (request_count >= 1),
  CONSTRAINT ip_activity_last_after_first CHECK (last_seen >= first_seen)
);

CREATE UNIQUE INDEX ip_activity_ip_user_unique ON ip_activity (ip, user_id) NULLS NOT DISTINCT;
CREATE INDEX ip_activity_ip_idx ON ip_activity (ip);
CREATE INDEX ip_activity_user_id_idx ON ip_activity (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ip_activity_flagged_idx ON ip_activity (flagged) WHERE flagged;
CREATE INDEX ip_activity_asn_idx ON ip_activity (asn) WHERE asn IS NOT NULL;

CREATE TRIGGER trg_ip_activity_set_updated_at
  BEFORE UPDATE ON ip_activity
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_ip_activity_bump_row_version
  BEFORE UPDATE ON ip_activity
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON ip_activity TO app_rw;
GRANT SELECT ON ip_activity TO app_ro;

COMMENT ON TABLE ip_activity IS 'Rolling per-(ip, user) request counters for IP monitoring, geo/ASN enrichment and impossible-travel flagging. user_id/device_id are optional actors, SET NULL on removal (the IP history itself is retained for security review).';
COMMENT ON COLUMN ip_activity.asn IS 'Autonomous System Number from IP enrichment, used to detect many accounts sharing one hosting provider.';
COMMENT ON COLUMN ip_activity.flagged IS 'Set by the abuse-detection job when this IP''s pattern looks suspicious (e.g. many distinct accounts, datacenter ASN with high velocity).';

-- ---------------------------------------------------------------------------

CREATE TABLE extension_installs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  install_id        text NOT NULL,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,

  version           text NOT NULL,
  browser           text,

  first_seen        timestamptz NOT NULL DEFAULT now(),
  last_seen         timestamptz NOT NULL DEFAULT now(),
  uninstalled_at    timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 0,

  CONSTRAINT extension_installs_last_after_first CHECK (last_seen >= first_seen)
);

CREATE UNIQUE INDEX extension_installs_install_id_unique ON extension_installs (install_id);
CREATE INDEX extension_installs_user_id_idx ON extension_installs (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX extension_installs_version_idx ON extension_installs (version);
CREATE INDEX extension_installs_active_idx ON extension_installs (last_seen) WHERE uninstalled_at IS NULL;

CREATE TRIGGER trg_extension_installs_set_updated_at
  BEFORE UPDATE ON extension_installs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_extension_installs_bump_row_version
  BEFORE UPDATE ON extension_installs
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON extension_installs TO app_rw;
GRANT SELECT ON extension_installs TO app_ro;

COMMENT ON TABLE extension_installs IS 'One row per browser install of the extension (pre-login installs included, hence nullable user_id), for install counts, version distribution and health. install_id is a client-generated stable id, independent of any account.';
COMMENT ON COLUMN extension_installs.install_id IS 'Client-generated stable identifier for this browser install, set on first run and persisted locally; not a fingerprint used for licensing (see devices.fingerprint_hash for that).';
