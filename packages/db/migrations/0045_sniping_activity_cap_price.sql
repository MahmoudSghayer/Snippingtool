-- 0045_sniping_activity_cap_price.sql
--
-- `cap_price`: the per-search Max price — the only buy/bid ceiling in Snipe
-- and Bid mode — in force when a snipe/bid attempt was made. Lets a report
-- show what was bought or bid against the cap the trader set, so an overpay
-- (a buy or bid above the max) shows up in the data instead of being
-- invisible. `target_price`/`listed_price` already record what was
-- paid/listed; this records the ceiling it was meant to stay under.
--
-- NULL for attempts from older extensions, the assist overlay and the
-- autobuyer (which carry no per-search max), and for Gallery mode (no user
-- max: it buys at the market to complete a Set).
--
-- ADD COLUMN with no default is metadata-only (no table rewrite), and on a
-- partitioned table it reaches every partition.
ALTER TABLE sniping_activity ADD COLUMN IF NOT EXISTS cap_price integer;

COMMENT ON COLUMN sniping_activity.cap_price IS
  'Nova AI bot: the per-search Max price (the only buy/bid ceiling in Snipe/Bid) in force for this attempt; NULL when there was no cap (older extensions, assist, autobuyer, Gallery).';
