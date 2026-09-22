-- Down for 0001_extensions_and_helpers.sql
-- Best-effort: DROP EXTENSION/DROP ROLE will fail if anything still depends
-- on them. Run this only after every later down migration has already
-- dropped the tables/functions/grants that depend on these.
DROP FUNCTION IF EXISTS create_month_partitions(text, date, int);
DROP FUNCTION IF EXISTS reject_write();
DROP FUNCTION IF EXISTS bump_row_version();
DROP FUNCTION IF EXISTS set_updated_at();

-- Roles: revoke membership before dropping. Fails loudly (by design) if any
-- object still has a GRANT to these roles outstanding — clean those up first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sl') THEN
    EXECUTE 'REVOKE app_rw FROM sl';
    EXECUTE 'REVOKE app_ro FROM sl';
  END IF;
END
$$;
DROP ROLE IF EXISTS app_rw;
DROP ROLE IF EXISTS app_ro;

DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS citext;
