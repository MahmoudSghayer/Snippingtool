-- migrate:no-transaction
-- 0033_trades_bought_at_idx.sql
--
-- `trades (user_id, bought_at DESC, id)`: the dashboard's trade list pages by
-- (bought_at, id) and the profit rollup sums a user's purchases per day;
-- both previously had only the bare user_id index. Built CONCURRENTLY so it
-- does not block trade writes while it builds on a live database (see the
-- no-transaction rules in packages/db/src/migrate.ts).
--
-- A failed CONCURRENTLY build leaves an INVALID index behind and this file
-- unrecorded; the DROP below clears it, so re-running the migration retries
-- the build cleanly.
DROP INDEX CONCURRENTLY IF EXISTS trades_user_id_bought_at_idx;
CREATE INDEX CONCURRENTLY IF NOT EXISTS trades_user_id_bought_at_idx ON trades (user_id, bought_at DESC, id) WHERE deleted_at IS NULL;
