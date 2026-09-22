-- Down for 0020_audit_logs.sql
-- Dropping the partitioned parent drops every partition (including
-- audit_logs_default and every audit_logs_yYYYYmMM created by
-- create_month_partitions) automatically.
DROP TABLE IF EXISTS audit_logs CASCADE;
