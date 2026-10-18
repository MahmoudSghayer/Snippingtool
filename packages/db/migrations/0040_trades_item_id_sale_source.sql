-- 0040_trades_item_id_sale_source.sql
--
-- Two columns on `trades` for following a bought card to its sale across
-- browsers (docs/06-extension.md, "Trade lifecycle"):
--
-- - `item_id`: EA's id for the card itself (`itemData.id`). Unlike the
--   listing's `trade_id` it survives the purchase and every relist, so it
--   is what links a sale to its buy. The extension sends it with the buy
--   report; `GET /api/v1/extension/open-trades` hands a browser the
--   account's trades still `bought` with their item ids, so a card bought
--   in one browser and sold while the bot runs in another still has its
--   sale reported. NULL for buys reported before this column, and for a
--   bought listing that carried no item id.
--
-- - `sale_source`: how the sale price came to be known.
--     observed  the extension saw the listing sold on the trade pile
--     inferred  a listed card left the trade pile unseen and was recorded
--               as sold at its buy-now price (EA lets nobody remove a card
--               whose listing is live), or an old `gone` record reported
--               once at its list price: an estimate
--     manual    the trader recorded it on the dashboard
--   NULL while the trade is not sold, and for sales stored before 0040.
--   An enum like every other closed set here (0002_enums.sql).
--
-- ADD COLUMN with no default is metadata-only (no table rewrite). The index
-- is partial on `item_id IS NOT NULL`, a column NULL in every existing row,
-- so building it only scans `trades` once and adds no entries: a plain
-- CREATE INDEX in this transaction rather than a separate CONCURRENTLY file
-- (0033), which could not create the type re-runnably.
CREATE TYPE trade_sale_source AS ENUM ('observed', 'inferred', 'manual');

ALTER TABLE trades ADD COLUMN item_id text;
ALTER TABLE trades ADD COLUMN sale_source trade_sale_source;

ALTER TABLE trades
  ADD CONSTRAINT trades_item_id_length CHECK (item_id IS NULL OR char_length(item_id) BETWEEN 1 AND 64);

CREATE INDEX trades_user_id_item_id_idx ON trades (user_id, item_id)
  WHERE deleted_at IS NULL AND item_id IS NOT NULL;

COMMENT ON TYPE trade_sale_source IS 'How a sold trade''s price is known: seen sold (observed), estimated at its list price (inferred), or entered by the trader (manual).';
COMMENT ON COLUMN trades.item_id IS
  'EA''s id for the card (itemData.id), constant across the purchase and every relist; links a sale to its buy across browsers. NULL when not reported.';
COMMENT ON COLUMN trades.sale_source IS
  'observed | inferred | manual for a sold trade; NULL while unsold and for sales stored before 0040.';
