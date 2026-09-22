-- 0014_risk_budget_events.sql
-- Safety-governor decisions, summarised from the extension so the dashboard
-- can show risk posture and admins can tune default budgets. Not one of the
-- four tables the plan calls out for declarative partitioning (user_activity,
-- search_activity, sniping_activity, audit_logs), so this is a plain table;
-- BRIN on occurred_at still keeps range scans cheap at volume.

CREATE TABLE risk_budget_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
  session_id    uuid REFERENCES sessions(id) ON DELETE SET NULL,

  kind          risk_event_kind NOT NULL,
  value         numeric(14, 4) NOT NULL,
  threshold     numeric(14, 4) NOT NULL,

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX risk_budget_events_user_id_idx ON risk_budget_events (user_id, occurred_at DESC);
CREATE INDEX risk_budget_events_device_id_idx ON risk_budget_events (device_id, occurred_at DESC);
CREATE INDEX risk_budget_events_session_id_idx ON risk_budget_events (session_id);
CREATE INDEX risk_budget_events_kind_idx ON risk_budget_events (kind, occurred_at DESC);
CREATE INDEX risk_budget_events_occurred_at_brin ON risk_budget_events USING brin (occurred_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON risk_budget_events TO app_rw;
GRANT SELECT ON risk_budget_events TO app_ro;

COMMENT ON TABLE risk_budget_events IS 'Safety-governor budget decisions (engine/governor.ts), synced from the extension: every threshold crossing, cooldown, hard stop or kill-switch trigger. CASCADE on user delete (pure child telemetry).';
COMMENT ON COLUMN risk_budget_events.kind IS 'Which budget this event concerns: actions_per_hour/session_length/buy_search_ratio/coin_flow/hard_stop/kill_switch.';
COMMENT ON COLUMN risk_budget_events.value IS 'Observed value at decision time (e.g. current actions/hour rate).';
COMMENT ON COLUMN risk_budget_events.threshold IS 'Configured threshold compared against, from admin-tunable governor defaults in system_config.';
