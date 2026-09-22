-- Down for 0023_analytics.sql
DROP FUNCTION IF EXISTS refresh_mv_kpi_daily();
DROP MATERIALIZED VIEW IF EXISTS mv_kpi_daily;
DROP VIEW IF EXISTS v_daily_profit;
DROP VIEW IF EXISTS v_user_lifetime_profit;
DROP VIEW IF EXISTS v_arr;
DROP VIEW IF EXISTS v_mrr;
DROP VIEW IF EXISTS v_active_subscriptions;
DROP TABLE IF EXISTS analytics_daily;
