-- 0038_sniping_activity_timings.sql
--
-- Where the time goes on a snipe, to tell a slow bot from a slow connection
-- (docs/08-analytics.md). `latency_ms` already holds the buy's own round
-- trip; two more timings come with each attempt from the Nova AI bot:
--
-- - `search_ms`: from the search being sent to EA to the listing arriving
--   in the page (EA's answer to that search).
-- - `reaction_ms`: from the listing arriving to the bot sending its buy.
--
-- Both NULL for attempts from older extensions, the assist overlay and the
-- autobuyer, and for attempts the governor blocked before any buy.
--
-- ADD COLUMN with no default is metadata-only (no table rewrite), and on a
-- partitioned table it reaches every partition.
ALTER TABLE sniping_activity ADD COLUMN IF NOT EXISTS search_ms integer;
ALTER TABLE sniping_activity ADD COLUMN IF NOT EXISTS reaction_ms integer;

COMMENT ON COLUMN sniping_activity.search_ms IS
  'Nova AI bot: ms from sending the search to the listing arriving; NULL when not measured.';
COMMENT ON COLUMN sniping_activity.reaction_ms IS
  'Nova AI bot: ms from the listing arriving to sending the buy; NULL when not measured.';
