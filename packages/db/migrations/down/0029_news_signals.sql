-- Down for 0029_news_signals.sql
DROP INDEX IF EXISTS news_items_pending_extraction_idx;
ALTER TABLE news_items
  DROP COLUMN IF EXISTS signals_extracted_at,
  DROP COLUMN IF EXISTS signals_model;

DROP TABLE IF EXISTS news_signals;

DROP TYPE IF EXISTS signal_review_decision;
DROP TYPE IF EXISTS signal_magnitude;
DROP TYPE IF EXISTS signal_direction;
