-- 0001_extensions_and_helpers.sql
-- Extensions, application roles, and generic trigger/helper functions shared by every
-- later migration. Nothing here is domain-specific.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- citext: case-insensitive text, used for `users.email` so lookups/uniqueness
-- are case-insensitive without normalising in application code.
CREATE EXTENSION IF NOT EXISTS citext;

-- pgcrypto: gen_random_uuid() (fallback default for uuid PKs; the app normally
-- supplies its own uuidv7 value) and pgp_sym_encrypt/decrypt used for
-- column-level encryption of TOTP secrets (see docs/09-security.md).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Application roles
--
-- The API connects as `app_rw` (read/write, but explicitly denied UPDATE/DELETE
-- on append-only tables such as audit_logs). Reporting/analytics tooling and
-- read replicas use `app_ro` (SELECT only). Both are NOLOGIN roles granted to
-- the actual login role(s) used by the API and job workers; this keeps the
-- privilege model in the database independent of how many login roles exist
-- per environment. Grants against these roles are applied incrementally as
-- each table is created, plus a blanket catch-up grant in
-- 0015_role_grants.sql.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN
    CREATE ROLE app_ro NOLOGIN NOINHERIT;
  END IF;
END
$$;

COMMENT ON ROLE app_rw IS 'Application read/write role used by the API and job workers. Explicitly denied UPDATE/DELETE on append-only tables (audit_logs).';
COMMENT ON ROLE app_ro IS 'Read-only role for analytics/reporting tooling and read replicas.';

-- Grant the roles to the migrating/superuser role `sl` so `sl` (or any login
-- role the deployment uses) can `SET ROLE app_rw` / `SET ROLE app_ro`, and so
-- future logins can simply be granted app_rw / app_ro membership.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sl') THEN
    EXECUTE 'GRANT app_rw TO sl';
    EXECUTE 'GRANT app_ro TO sl';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Generic trigger functions
-- ---------------------------------------------------------------------------

-- set_updated_at(): stamps NEW.updated_at = now() on every UPDATE. Attached
-- as a BEFORE UPDATE trigger to every table that has an `updated_at` column.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION set_updated_at() IS 'BEFORE UPDATE trigger: sets NEW.updated_at = now(). Attached to every table with an updated_at column.';

-- bump_row_version(): increments NEW.row_version on every UPDATE. Used for
-- optimistic concurrency control by the API layer (a write includes
-- `WHERE row_version = :expected`).
CREATE OR REPLACE FUNCTION bump_row_version()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION bump_row_version() IS 'BEFORE UPDATE trigger: increments NEW.row_version for optimistic concurrency control. Attached to every table with a row_version column.';

-- reject_write(): attached as a BEFORE UPDATE OR DELETE trigger on append-only
-- tables (audit_logs). The table-level REVOKE UPDATE/DELETE FROM app_rw is the
-- primary control; this trigger is belt-and-braces in case a row is ever
-- touched by a role that does have the privilege (e.g. a superuser doing
-- manual maintenance without due care).
CREATE OR REPLACE FUNCTION reject_write()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

COMMENT ON FUNCTION reject_write() IS 'BEFORE UPDATE OR DELETE trigger that unconditionally raises. Belt-and-braces guard for append-only tables, alongside the table-level REVOKE.';

-- ---------------------------------------------------------------------------
-- Declarative monthly partition helper
--
-- create_month_partitions(parent, from_month, months) creates one RANGE
-- partition per calendar month, named "<parent>_yYYYY_mMM", covering
-- [from_month, from_month + months). from_month is truncated to the first of
-- its month. Idempotent: uses CREATE TABLE IF NOT EXISTS. Every partitioned
-- table also gets a "<parent>_default" DEFAULT partition (created separately,
-- once, right after the parent table) to catch any row outside the declared
-- ranges rather than failing the insert.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_month_partitions(
  parent text,
  from_month date,
  months int
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  start_date date := date_trunc('month', from_month)::date;
  part_start date;
  part_end date;
  part_name text;
  i int;
BEGIN
  IF months < 1 THEN
    RAISE EXCEPTION 'months must be >= 1, got %', months;
  END IF;

  FOR i IN 0 .. months - 1 LOOP
    part_start := (start_date + (i || ' months')::interval)::date;
    part_end := (start_date + ((i + 1) || ' months')::interval)::date;
    part_name := format('%s_y%sm%s', parent, to_char(part_start, 'YYYY'), to_char(part_start, 'MM'));

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      part_name, parent, part_start, part_end
    );
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION create_month_partitions(text, date, int) IS 'Creates monthly RANGE partitions of `parent` (a declaratively partitioned table keyed on a timestamptz column truncated to month) covering `months` calendar months starting at from_month. Idempotent. Call again with a later from_month to extend coverage (see docs/02-database.md partition maintenance runbook).';
