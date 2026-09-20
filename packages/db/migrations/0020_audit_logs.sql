-- 0020_audit_logs.sql
-- Append-only, before/after diffing audit trail for every mutating request
-- (admin and non-admin). Hard-enforced append-only two ways: (1) REVOKE
-- UPDATE/DELETE from app_rw, the role the API connects as, so a compromised
-- or buggy API process cannot alter history; (2) a BEFORE UPDATE OR DELETE
-- trigger that raises unconditionally, as a second line of defense for any
-- role/session that does hold the privilege (e.g. manual superuser
-- maintenance without due care). Partitioned by month on occurred_at like the
-- other high-volume tables.

CREATE TABLE audit_logs (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),

  actor_type    audit_actor_type NOT NULL,
  actor_id      uuid,

  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     uuid,

  before        jsonb,
  after         jsonb,
  diff          jsonb,

  ip            inet,
  user_agent    text,
  request_id    uuid,

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_logs_pkey PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_logs_before_is_object_or_null CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  CONSTRAINT audit_logs_after_is_object_or_null CHECK (after IS NULL OR jsonb_typeof(after) = 'object'),
  CONSTRAINT audit_logs_diff_is_object_or_null CHECK (diff IS NULL OR jsonb_typeof(diff) = 'object'),
  -- system actors don't have an actor_id; user/admin actors must supply one.
  CONSTRAINT audit_logs_actor_id_required_unless_system CHECK (actor_type = 'system' OR actor_id IS NOT NULL)
) PARTITION BY RANGE (occurred_at);

-- Deliberately no FK on actor_id/entity_id: audit_logs is polymorphic
-- (actor_type/entity_type select which table actor_id/entity_id points into),
-- and rows must outlive the entities they describe (an entity or actor may be
-- hard-deleted later; the audit trail must not be).

CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_type, actor_id, occurred_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at DESC);
CREATE INDEX audit_logs_request_id_idx ON audit_logs (request_id);
CREATE INDEX audit_logs_occurred_at_brin ON audit_logs USING brin (occurred_at);
CREATE INDEX audit_logs_diff_gin ON audit_logs USING gin (diff);

SELECT create_month_partitions('audit_logs', date_trunc('month', now())::date, 13);

CREATE TRIGGER trg_audit_logs_reject_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_write();

-- Primary enforcement: the API's connection role (app_rw) may INSERT and
-- SELECT, never UPDATE or DELETE. Postgres REVOKE on a partitioned parent
-- applies to the parent and is inherited by partitions created after this
-- point via create_month_partitions(); partitions created before a GRANT
-- change already share the same privileges because privileges on partitions
-- are checked via the table actually targeted, and INSERT/SELECT are what we
-- grant explicitly below (never UPDATE/DELETE), so no partition ever gets
-- write access app_rw wasn't given.
GRANT SELECT, INSERT ON audit_logs TO app_rw;
REVOKE UPDATE, DELETE ON audit_logs FROM app_rw;
GRANT SELECT ON audit_logs TO app_ro;
REVOKE UPDATE, DELETE ON audit_logs FROM app_ro;

COMMENT ON TABLE audit_logs IS 'Append-only audit trail: before/after/diff JSONB for every mutating request. UPDATE/DELETE revoked from app_rw and app_ro, plus a trigger that rejects them outright. Partitioned by month on occurred_at.';
COMMENT ON COLUMN audit_logs.actor_type IS 'user/admin/system — who performed the action.';
COMMENT ON COLUMN audit_logs.actor_id IS 'Polymorphic id into users or admin_users depending on actor_type; no FK (see table comment). Null only when actor_type=system.';
COMMENT ON COLUMN audit_logs.entity_type IS 'Polymorphic entity table name this row describes, e.g. "subscription", "coupon".';
COMMENT ON COLUMN audit_logs.before IS 'Entity state before the change, or null for a create.';
COMMENT ON COLUMN audit_logs.after IS 'Entity state after the change, or null for a delete.';
COMMENT ON COLUMN audit_logs.diff IS 'App-computed before/after diff (see apps/api lib/audit-diff), stored redundantly with before/after for fast diff-viewer rendering.';
COMMENT ON COLUMN audit_logs.request_id IS 'Correlates to the API''s x-request-id for cross-referencing logs/traces.';
