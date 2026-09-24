-- Down for 0027_market_intelligence.sql
-- Partitions drop with their parent; the enums go last because the tables
-- depend on them.

DROP TABLE IF EXISTS collector_runs;
DROP TABLE IF EXISTS raw_documents;
DROP TABLE IF EXISTS price_observations;
DROP TABLE IF EXISTS card_source_ids;
DROP TABLE IF EXISTS cards;

DROP TYPE IF EXISTS collector_run_status;
DROP TYPE IF EXISTS price_kind;
DROP TYPE IF EXISTS market_platform;
DROP TYPE IF EXISTS market_source;
