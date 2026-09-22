-- 0004_admin.sql
-- Admin-panel identity (admin_users) and the append-oriented log of admin
-- actions (admin_actions). admin_actions is a convenience/query-optimised
-- log distinct from the generic audit_logs table: admin_actions is written
-- directly by the admin API for "what did admins do" screens, while
-- audit_logs captures before/after diffs for every mutating request
-- (including non-admin ones). See docs/02-database.md for the split.

CREATE TABLE admin_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,

  admin_role          admin_role NOT NULL,
  permissions         jsonb NOT NULL DEFAULT '{}'::jsonb,

  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  row_version         integer NOT NULL DEFAULT 0,

  CONSTRAINT admin_users_permissions_is_object CHECK (jsonb_typeof(permissions) = 'object')
);

CREATE INDEX admin_users_admin_role_idx ON admin_users (admin_role) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_admin_users_set_updated_at
  BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_admin_users_bump_row_version
  BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_users TO app_rw;
GRANT SELECT ON admin_users TO app_ro;

COMMENT ON TABLE admin_users IS 'Admin-panel identity: one row per user granted admin access. ON DELETE RESTRICT on user_id so an admin''s underlying user cannot be hard-deleted while still linked here.';
COMMENT ON COLUMN admin_users.admin_role IS 'super_admin/support/analyst/billing; gates the permission matrix defaults in packages/shared/permissions.ts.';
COMMENT ON COLUMN admin_users.permissions IS 'Object of fine-grained permission overrides layered on top of admin_role defaults, e.g. {"users.ban": true}.';

-- ---------------------------------------------------------------------------

CREATE TABLE admin_actions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id       uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,

  action              text NOT NULL,
  target_type         text NOT NULL,
  target_id           uuid,
  reason              text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,

  occurred_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT admin_actions_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX admin_actions_admin_user_id_idx ON admin_actions (admin_user_id, occurred_at DESC);
CREATE INDEX admin_actions_target_idx ON admin_actions (target_type, target_id);
CREATE INDEX admin_actions_action_idx ON admin_actions (action);
CREATE INDEX admin_actions_occurred_at_idx ON admin_actions (occurred_at DESC);
CREATE INDEX admin_actions_metadata_gin_idx ON admin_actions USING gin (metadata);

GRANT SELECT, INSERT ON admin_actions TO app_rw;
GRANT SELECT ON admin_actions TO app_ro;

COMMENT ON TABLE admin_actions IS 'Append-oriented log of admin-initiated actions for the admin activity screen. No soft delete / no updated_at: rows are write-once (enforced at the app layer; see audit_logs for the hard-enforced append-only log).';
COMMENT ON COLUMN admin_actions.action IS 'Machine-readable action name, e.g. "subscription.suspend", "coupon.create".';
COMMENT ON COLUMN admin_actions.target_type IS 'Entity type acted upon, e.g. "user", "subscription", "coupon".';
COMMENT ON COLUMN admin_actions.target_id IS 'Entity id acted upon; nullable for actions without a single target (e.g. bulk operations, config changes).';
COMMENT ON COLUMN admin_actions.metadata IS 'Action-specific structured detail, e.g. {"from_plan":"pro","to_plan":"ultimate"}.';
