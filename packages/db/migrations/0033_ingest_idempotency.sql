-- 0033_ingest_idempotency.sql
--
-- Ingest correctness (docs/02-database.md, docs/08-analytics.md):
--
-- 1. `sniping_activity.attempt_id` — a client-generated id per snipe
--    attempt. The extension re-sends a batch when its flush fails, and
--    before this every retry inserted the attempts again, inflating snipe
--    counts and success rates. The ingest route now inserts with
--    ON CONFLICT DO NOTHING against the unique index below. The table is
--    range-partitioned on occurred_at, and Postgres requires the partition
--    key in every unique index on a partitioned table, so the key is
--    (user_id, attempt_id, occurred_at); the extension keeps the attempt's
--    original occurred_at with it in its queue, so a retry matches. The
--    column is nullable for extensions built before it existed, and NULLs
--    never conflict, so those rows are stored as before.
--
-- 2. `trades (user_id, bought_at DESC, id)` — the dashboard's trade list
--    pages by (bought_at, id) and the profit rollup sums a user's purchases
--    per day; both previously had only the bare user_id index.
--
-- 3. `default_partition_row_count(parent)` — `partitions.maintain` reports
--    rows stranded in a table's DEFAULT partition, because while any are
--    there Postgres refuses to create the partition covering them.

ALTER TABLE sniping_activity ADD COLUMN attempt_id uuid;

CREATE UNIQUE INDEX sniping_activity_user_id_attempt_id_unique
  ON sniping_activity (user_id, attempt_id, occurred_at);

COMMENT ON COLUMN sniping_activity.attempt_id IS 'Client-generated id of this attempt; unique per user with occurred_at so a retried batch is stored once. NULL for attempts from extensions that predate it.';

CREATE INDEX trades_user_id_bought_at_idx
  ON trades (user_id, bought_at DESC, id) WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION default_partition_row_count(parent text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %I', parent || '_default') INTO n;
  RETURN n;
END;
$fn$;

COMMENT ON FUNCTION default_partition_row_count(text) IS 'Rows in "<parent>_default", the DEFAULT partition every partitioned table has. Non-zero means rows fell outside the monthly ranges; partitions.maintain logs it, since those rows block creating the partition that covers them.';
