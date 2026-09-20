-- Down for 0024_role_grants.sql
-- Best-effort: reverting default privileges to "no default" is what these
-- REVOKEs do; they do not retroactively strip privileges already granted on
-- existing tables (those are reverted by each table's own down migration
-- dropping the table).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM app_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM app_rw;
