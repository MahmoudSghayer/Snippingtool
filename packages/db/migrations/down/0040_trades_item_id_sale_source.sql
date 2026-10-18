-- Down for 0040_trades_item_id_sale_source.sql. The type goes last: the
-- column depends on it.
DROP INDEX IF EXISTS trades_user_id_item_id_idx;
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_item_id_length;
ALTER TABLE trades DROP COLUMN IF EXISTS sale_source;
ALTER TABLE trades DROP COLUMN IF EXISTS item_id;
DROP TYPE IF EXISTS trade_sale_source;
