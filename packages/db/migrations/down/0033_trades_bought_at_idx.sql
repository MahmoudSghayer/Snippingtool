-- Down for 0033_trades_bought_at_idx.sql (down files always run in a
-- transaction, so this is a plain DROP INDEX).
DROP INDEX IF EXISTS trades_user_id_bought_at_idx;
