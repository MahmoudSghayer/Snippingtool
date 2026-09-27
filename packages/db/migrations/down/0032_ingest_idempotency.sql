-- Down for 0032_ingest_idempotency.sql
DROP FUNCTION IF EXISTS default_partition_row_count(text);
DROP INDEX IF EXISTS sniping_activity_user_id_attempt_id_unique;
ALTER TABLE sniping_activity DROP COLUMN IF EXISTS attempt_id;
