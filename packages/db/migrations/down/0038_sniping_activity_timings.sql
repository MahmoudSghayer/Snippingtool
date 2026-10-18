-- Down for 0038_sniping_activity_timings.sql.
ALTER TABLE sniping_activity DROP COLUMN IF EXISTS reaction_ms;
ALTER TABLE sniping_activity DROP COLUMN IF EXISTS search_ms;
