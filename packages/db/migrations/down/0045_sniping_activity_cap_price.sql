-- Down for 0045_sniping_activity_cap_price.sql. Dropping the column discards
-- the recorded caps; on a partitioned table the drop reaches every partition.
ALTER TABLE sniping_activity DROP COLUMN IF EXISTS cap_price;
