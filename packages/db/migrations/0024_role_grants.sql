-- 0024_role_grants.sql
-- Catch-up + forward-looking grants. Every table so far has granted app_rw/
-- app_ro explicitly at creation time (and audit_logs explicitly revoked
-- UPDATE/DELETE from both); this migration (a) re-asserts a blanket grant so
-- nothing was missed, and (b) sets ALTER DEFAULT PRIVILEGES so any table
-- created later by the same role automatically grants the right access
-- without a follow-up migration being able to forget it — except audit_logs,
-- whose restriction must still be asserted per-table since default privileges
-- cannot special-case one table name.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT SELECT ON %I.%I TO app_ro', r.schemaname, r.tablename);
    IF r.tablename = 'audit_logs' THEN
      EXECUTE format('GRANT SELECT, INSERT ON %I.%I TO app_rw', r.schemaname, r.tablename);
      EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM app_rw', r.schemaname, r.tablename);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO app_rw', r.schemaname, r.tablename);
    END IF;
  END LOOP;

  FOR r IN
    SELECT schemaname, matviewname AS tablename FROM pg_matviews WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT SELECT ON %I.%I TO app_ro', r.schemaname, r.tablename);
    EXECUTE format('GRANT SELECT ON %I.%I TO app_rw', r.schemaname, r.tablename);
  END LOOP;
END
$$;

-- Forward-looking: any table the migrating role creates from now on defaults
-- to app_rw read/write + app_ro read-only. audit_logs-style append-only
-- tables must still explicitly REVOKE UPDATE/DELETE in their own migration
-- (as 0020 does) since that cannot be expressed as a blanket default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

COMMENT ON SCHEMA public IS 'The Sniper''s Ledger application schema. app_rw = API/worker role (read/write, minus append-only tables). app_ro = reporting/analytics read-only role. See packages/db/migrations for the numbered history and docs/02-database.md for the ERD and per-table docs.';
