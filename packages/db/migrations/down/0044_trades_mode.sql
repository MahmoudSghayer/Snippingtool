-- Down for 0044_trades_mode.sql. The type goes last: the column depends on it.
-- (The backfill is not reversed — dropping the column discards it.)
ALTER TABLE trades DROP COLUMN IF EXISTS mode;
DROP TYPE IF EXISTS trade_mode;
