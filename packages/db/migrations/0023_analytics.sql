-- 0023_analytics.sql
-- Materialised KPI store, plans/subscriptions/profit reporting views.

CREATE TABLE analytics_daily (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  day           date NOT NULL,
  metric        text NOT NULL,
  dimension     text NOT NULL DEFAULT '',
  value         numeric(18, 4) NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX analytics_daily_day_metric_dimension_unique ON analytics_daily (day, metric, dimension);
CREATE INDEX analytics_daily_metric_idx ON analytics_daily (metric, day DESC);
CREATE INDEX analytics_daily_day_idx ON analytics_daily (day DESC);

CREATE TRIGGER trg_analytics_daily_set_updated_at
  BEFORE UPDATE ON analytics_daily
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_analytics_daily_bump_row_version
  BEFORE UPDATE ON analytics_daily
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_daily TO app_rw;
GRANT SELECT ON analytics_daily TO app_ro;

COMMENT ON TABLE analytics_daily IS 'Generic materialised KPI store: one row per (day, metric, dimension), e.g. (2026-09-20, "installs", "chrome") = 412. Populated by the analytics.daily nightly job. Every metric formula is documented in docs/08-analytics.md.';
COMMENT ON COLUMN analytics_daily.dimension IS 'Optional metric breakdown key (e.g. browser, plan code); empty string for un-dimensioned metrics, part of the unique key so each breakdown gets its own row.';

-- ---------------------------------------------------------------------------
-- Reporting views
-- ---------------------------------------------------------------------------

CREATE VIEW v_active_subscriptions AS
SELECT
  s.id,
  s.user_id,
  s.plan_id,
  p.code AS plan_code,
  p.name AS plan_name,
  p.price_cents,
  p.interval,
  p.is_lifetime,
  s.status,
  s.current_period_start,
  s.current_period_end,
  s.trial_ends_at,
  s.cancel_at_period_end,
  s.auto_renew,
  s.source,
  s.created_at
FROM subscriptions s
JOIN plans p ON p.id = s.plan_id
WHERE s.deleted_at IS NULL
  AND s.status IN ('trialing', 'active', 'past_due', 'suspended', 'lifetime');

COMMENT ON VIEW v_active_subscriptions IS 'All subscriptions currently in a live (non-terminal) status, joined to their plan.';

-- MRR: active, non-lifetime subscriptions, plan price normalised to a
-- monthly amount (year/12, week*4.345, day*30.44 — average days/weeks per
-- month). Lifetime plans and non-active statuses (trialing/past_due/
-- suspended/canceled/expired) do not contribute recurring revenue.
CREATE VIEW v_mrr AS
SELECT
  COALESCE(SUM(
    CASE p.interval
      WHEN 'month' THEN p.price_cents
      WHEN 'year'  THEN p.price_cents / 12.0
      WHEN 'week'  THEN p.price_cents * 4.345
      WHEN 'day'   THEN p.price_cents * 30.44
      ELSE 0
    END
  ), 0)::numeric(18, 4) AS mrr_cents
FROM subscriptions s
JOIN plans p ON p.id = s.plan_id
WHERE s.deleted_at IS NULL
  AND s.status = 'active'
  AND p.is_lifetime = false;

COMMENT ON VIEW v_mrr IS 'Monthly recurring revenue in cents: sum of active, non-lifetime subscriptions'' plan prices, each normalised to a monthly equivalent. Formula detail in docs/08-analytics.md.';

CREATE VIEW v_arr AS
SELECT mrr_cents * 12 AS arr_cents FROM v_mrr;

COMMENT ON VIEW v_arr IS 'Annual recurring revenue in cents: v_mrr.mrr_cents * 12.';

CREATE VIEW v_user_lifetime_profit AS
SELECT
  user_id,
  SUM(net_profit)::bigint AS lifetime_net_profit,
  SUM(coins_spent)::bigint AS lifetime_coins_spent,
  SUM(coins_earned)::bigint AS lifetime_coins_earned,
  SUM(snipes)::bigint AS lifetime_snipes,
  SUM(successes)::bigint AS lifetime_successes,
  SUM(trades_closed)::bigint AS lifetime_trades_closed,
  MIN(day) AS first_active_day,
  MAX(day) AS last_active_day
FROM profits
GROUP BY user_id;

COMMENT ON VIEW v_user_lifetime_profit IS 'Per-user all-time totals, aggregated from the profits daily rollup table.';

CREATE VIEW v_daily_profit AS
SELECT
  day,
  SUM(net_profit)::bigint AS net_profit,
  SUM(coins_spent)::bigint AS coins_spent,
  SUM(coins_earned)::bigint AS coins_earned,
  SUM(snipes)::bigint AS snipes,
  SUM(successes)::bigint AS successes,
  SUM(trades_closed)::bigint AS trades_closed,
  COUNT(DISTINCT user_id) AS active_traders
FROM profits
GROUP BY day
ORDER BY day;

COMMENT ON VIEW v_daily_profit IS 'Platform-wide daily rollup across all users, aggregated from the profits table. Backs the admin profit-analytics date-range charts.';

GRANT SELECT ON v_active_subscriptions, v_mrr, v_arr, v_user_lifetime_profit, v_daily_profit TO app_rw, app_ro;

-- ---------------------------------------------------------------------------
-- mv_kpi_daily: materialised per-day KPI snapshot, refreshed by
-- refresh_mv_kpi_daily() (called from the analytics.daily nightly job, and
-- safe to call ad hoc). Uses REFRESH ... CONCURRENTLY (needs the unique
-- index below) so readers are never blocked.
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW mv_kpi_daily AS
WITH bounds AS (
  SELECT COALESCE((SELECT min(day) FROM profits), current_date) AS start_day
),
days AS (
  SELECT generate_series(bounds.start_day, current_date, interval '1 day')::date AS day
  FROM bounds
),
signups AS (
  SELECT date_trunc('day', created_at)::date AS day, count(*) AS new_users
  FROM users
  WHERE deleted_at IS NULL
  GROUP BY 1
),
active AS (
  SELECT date_trunc('day', occurred_at)::date AS day, count(DISTINCT user_id) AS active_users
  FROM user_activity
  GROUP BY 1
),
profit_agg AS (
  SELECT day, SUM(net_profit) AS net_profit_cents, SUM(snipes) AS snipes, SUM(successes) AS successes
  FROM profits
  GROUP BY day
),
revenue AS (
  SELECT date_trunc('day', created_at)::date AS day, SUM(amount_cents) AS revenue_cents
  FROM payments
  WHERE status = 'succeeded'
  GROUP BY 1
)
SELECT
  d.day,
  COALESCE(s.new_users, 0)::bigint AS new_users,
  COALESCE(a.active_users, 0)::bigint AS active_users,
  COALESCE(p.net_profit_cents, 0)::bigint AS net_profit_cents,
  COALESCE(p.snipes, 0)::bigint AS snipes,
  COALESCE(p.successes, 0)::bigint AS successes,
  COALESCE(r.revenue_cents, 0)::bigint AS revenue_cents
FROM days d
LEFT JOIN signups s ON s.day = d.day
LEFT JOIN active a ON a.day = d.day
LEFT JOIN profit_agg p ON p.day = d.day
LEFT JOIN revenue r ON r.day = d.day
WITH DATA;

CREATE UNIQUE INDEX mv_kpi_daily_day_unique ON mv_kpi_daily (day);

GRANT SELECT ON mv_kpi_daily TO app_rw, app_ro;

COMMENT ON MATERIALIZED VIEW mv_kpi_daily IS 'One row per calendar day: new_users, active_users, net_profit_cents, snipes, successes, revenue_cents. Refresh with SELECT refresh_mv_kpi_daily(). Backs the admin overview KPI screen.';

CREATE OR REPLACE FUNCTION refresh_mv_kpi_daily()
RETURNS void
LANGUAGE sql
AS $fn$
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_kpi_daily;
$fn$;

COMMENT ON FUNCTION refresh_mv_kpi_daily() IS 'Refreshes mv_kpi_daily without locking readers (requires the mv_kpi_daily_day_unique index). Called by the analytics.daily nightly job.';

GRANT EXECUTE ON FUNCTION refresh_mv_kpi_daily() TO app_rw;
