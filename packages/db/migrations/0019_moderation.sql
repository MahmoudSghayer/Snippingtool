-- 0019_moderation.sql

CREATE TABLE bans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  type          ban_type NOT NULL,
  value         text NOT NULL,
  reason        text NOT NULL,

  issued_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at    timestamptz,
  lifted_at     timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  -- account bans always carry a user_id; ip/device/hwid bans identify their
  -- target purely through `value` and user_id may be null.
  CONSTRAINT bans_account_requires_user CHECK (type <> 'account' OR user_id IS NOT NULL)
);

CREATE INDEX bans_user_id_idx ON bans (user_id) WHERE lifted_at IS NULL;
CREATE INDEX bans_type_value_idx ON bans (type, value) WHERE lifted_at IS NULL;
CREATE INDEX bans_expires_at_idx ON bans (expires_at) WHERE lifted_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX bans_active_idx ON bans (type, value) WHERE lifted_at IS NULL AND (expires_at IS NULL);

CREATE TRIGGER trg_bans_set_updated_at
  BEFORE UPDATE ON bans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_bans_bump_row_version
  BEFORE UPDATE ON bans
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON bans TO app_rw;
GRANT SELECT ON bans TO app_ro;

COMMENT ON TABLE bans IS 'Account/IP/device/hardware-id bans. user_id is SET NULL on user removal (an IP/device ban must survive account deletion); issued_by is an optional actor (admin), also SET NULL.';
COMMENT ON COLUMN bans.type IS 'What `value` identifies: account (user_id required), ip, device (fingerprint_hash), or hwid.';
COMMENT ON COLUMN bans.value IS 'The banned identifier itself: user id as text for account, an IP/CIDR for ip, a fingerprint hash for device, a hardware id for hwid.';
COMMENT ON COLUMN bans.expires_at IS 'Null means indefinite; lifted_at (if set) ends the ban early regardless of expires_at.';

-- ---------------------------------------------------------------------------

CREATE TABLE flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  kind          flag_kind NOT NULL,
  severity      flag_severity NOT NULL DEFAULT 'medium',
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,

  status        flag_status NOT NULL DEFAULT 'open',
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  CONSTRAINT flags_evidence_is_object CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT flags_reviewed_consistency CHECK (
    (status = 'open') = (reviewed_at IS NULL)
  )
);

CREATE INDEX flags_user_id_idx ON flags (user_id);
CREATE INDEX flags_status_idx ON flags (status) WHERE status = 'open';
CREATE INDEX flags_kind_idx ON flags (kind);
CREATE INDEX flags_severity_idx ON flags (severity) WHERE status = 'open';
CREATE INDEX flags_evidence_gin ON flags USING gin (evidence);

CREATE TRIGGER trg_flags_set_updated_at
  BEFORE UPDATE ON flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_flags_bump_row_version
  BEFORE UPDATE ON flags
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON flags TO app_rw;
GRANT SELECT ON flags TO app_ro;

COMMENT ON TABLE flags IS 'Abuse/fraud flags raised by the abuse.scan job or an admin (trial_abuse/multi_account/velocity/chargeback/suspicious_ip). RESTRICT on user_id: a flag is evidence and must not be silently lost. reviewed_by is an optional actor (admin), SET NULL if removed.';
COMMENT ON COLUMN flags.evidence IS 'Structured evidence supporting the flag, e.g. {"shared_device_count": 6, "ips": [...]}.';
COMMENT ON COLUMN flags.status IS 'open/reviewed/dismissed; reviewed_at is set exactly when status leaves open (CHECK).';
