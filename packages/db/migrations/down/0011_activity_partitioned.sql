-- Down for 0011_activity_partitioned.sql
-- Dropping each partitioned parent drops all of its partitions (including
-- the *_default partition and every *_yYYYYmMM partition) automatically.
DROP TABLE IF EXISTS sniping_activity CASCADE;
DROP TABLE IF EXISTS search_activity CASCADE;
DROP TABLE IF EXISTS user_activity CASCADE;
