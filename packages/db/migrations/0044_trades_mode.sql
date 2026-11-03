-- 0044_trades_mode.sql
--
-- `trades.mode`: which bot mode bought the card — snipe, bid or gallery.
--
-- Why: profit analytics (the `profits` daily rollup and every admin/analytics
-- surface that reads it) are meant to reflect snipe + bid trading only. FC
-- Gallery mode buys a card, sends it through the club to complete a Set for
-- its token reward, then re-lists it at a deliberate loss — the loss is the
-- cost of the grind, not a failed trade. Counted alongside snipe/bid it drags
-- the profit numbers down and misrepresents trading performance. A mode tag
-- lets the rollup exclude gallery (lib/analytics/rollup.ts).
--
-- The extension reports `mode` on each buy going forward (null before this
-- column). For history, we backfill `gallery` from the collected-card
-- catalogue (user_gallery_owned, 0042): a card counts for FC's Gallery only
-- once it has passed through the club, so every clubbed card id is a card the
-- bot bought in Gallery mode. Trades whose resource_id is in that catalogue
-- for the same account are marked gallery. Best-effort: a card both sniped and
-- (separately) clubbed for a Set shares one resource_id and is caught here
-- too; such overlap is rare. Anything left null is treated as non-gallery
-- (counted), so the default can only under-exclude, never hide real trades.
--
-- ADD COLUMN with no default is metadata-only (no table rewrite). The backfill
-- UPDATE touches only rows whose card is catalogued; user_gallery_owned's
-- primary key (user_id, resource_id) makes the EXISTS an index lookup. No new
-- index: the rollup already scans trades by (user_id, bought_at/sold_at) and
-- applies `mode` as a cheap row filter.
CREATE TYPE trade_mode AS ENUM ('snipe', 'bid', 'gallery');

ALTER TABLE trades ADD COLUMN mode trade_mode;

-- Backfill historical Gallery trades from the clubbed-card catalogue. The
-- guard `~ '^[0-9]+$'` keeps the ::bigint cast safe for any non-numeric
-- resource_id.
UPDATE trades t
SET mode = 'gallery'
WHERE t.deleted_at IS NULL
  AND t.resource_id ~ '^[0-9]+$'
  AND EXISTS (
    SELECT 1
      FROM user_gallery_owned o
     WHERE o.user_id = t.user_id
       AND o.resource_id = t.resource_id::bigint
  );

COMMENT ON TYPE trade_mode IS 'Which bot mode bought the card: snipe | bid | gallery. Profit analytics count snipe + bid only; gallery is the Set-completion grind, excluded from every profit surface.';
COMMENT ON COLUMN trades.mode IS
  'snipe | bid | gallery (0044). The rollup excludes gallery. NULL for trades from before the column and not since backfilled from the clubbed-card catalogue; treated as non-gallery.';
