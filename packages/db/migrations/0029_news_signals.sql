-- 0029_news_signals.sql
-- Phase D of docs/14-ml-suggestions.md: what an announcement actually says
-- about prices, extracted from the article text into a strict shape.
--
-- Two design rules carried over from the scope doc, both of which exist
-- because this is the first phase whose output can be confidently wrong in a
-- way that looks right:
--
--   1. **Structured only.** A signal is a direction, a magnitude bucket, a
--      target and a confidence. There is deliberately no field for the model
--      to write a prediction in prose, because prose reads as authoritative
--      and cannot be measured. `rationale` exists for a reviewer to judge the
--      extraction, not for a user to read as advice.
--   2. **Nothing reaches a user unreviewed.** `reviewed_at IS NULL` is the
--      queue. Until measured precision justifies loosening it, a human
--      accepts or rejects every signal, and the accept/reject record is what
--      makes that precision measurable at all.
--
-- The target is either a card or a *cohort predicate*, never only a card. A
-- Pitch Notes playstyle nerf reprices every card carrying that playstyle —
-- modelling signals as card-only would force the extractor to either invent a
-- card list it cannot know or drop the most valuable signal there is.

CREATE TYPE signal_direction AS ENUM ('up', 'down', 'unclear');

-- Buckets, not percentages. The article says "buffed" or "nerfed"; it does not
-- say "-14%". A number here would be false precision that later evaluation
-- would then score against.
CREATE TYPE signal_magnitude AS ENUM ('small', 'moderate', 'large', 'unclear');

CREATE TYPE signal_review_decision AS ENUM ('accepted', 'rejected', 'unsure');

CREATE TABLE news_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  news_item_id    uuid NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,

  direction       signal_direction NOT NULL,
  magnitude       signal_magnitude NOT NULL,
  -- The extractor's own stated confidence, 0..1. Kept separate from the
  -- reviewer's verdict: a confidently wrong signal is exactly the failure
  -- mode worth being able to count.
  confidence      numeric(4, 3) NOT NULL,

  -- Exactly one of these two is set (enforced below).
  card_id         uuid REFERENCES cards(id) ON DELETE SET NULL,
  -- e.g. {"playstyle": "Rapid"} or {"league": 13, "ratingMin": 84}.
  -- Free-form because the vocabulary is whatever the announcement used;
  -- matching it to cards is a separate, reviewable step.
  cohort          jsonb,
  /** The raw phrase the extractor keyed on, so a reviewer can check the
   * extraction against the article without re-reading the whole thing. */
  evidence        text,
  rationale       text,

  -- Provenance. Precision is only meaningful per model+prompt, so both are
  -- recorded and neither is nullable.
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  extracted_at    timestamptz NOT NULL DEFAULT now(),

  -- The review queue. NULL reviewed_at means pending; nothing user-facing
  -- may read a row in that state.
  reviewed_at     timestamptz,
  review_decision signal_review_decision,
  reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT news_signals_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  -- A signal targets a card or a cohort, never both and never neither.
  -- Without this a row can exist that points at nothing and still counts as
  -- a signal.
  CONSTRAINT news_signals_one_target CHECK (
    (card_id IS NOT NULL AND cohort IS NULL) OR (card_id IS NULL AND cohort IS NOT NULL)
  ),
  -- A review is a decision plus a timestamp, or neither. Half a review is
  -- indistinguishable from an unreviewed row when querying the queue.
  CONSTRAINT news_signals_review_complete CHECK (
    (reviewed_at IS NULL AND review_decision IS NULL)
    OR (reviewed_at IS NOT NULL AND review_decision IS NOT NULL)
  )
);

CREATE INDEX news_signals_news_item_idx ON news_signals (news_item_id);
CREATE INDEX news_signals_card_idx ON news_signals (card_id) WHERE card_id IS NOT NULL;
CREATE INDEX news_signals_cohort_gin ON news_signals USING gin (cohort jsonb_path_ops)
  WHERE cohort IS NOT NULL;
-- The review queue, oldest first.
CREATE INDEX news_signals_pending_idx ON news_signals (extracted_at)
  WHERE reviewed_at IS NULL;
-- Precision measurement: accepted vs rejected per model+prompt.
CREATE INDEX news_signals_precision_idx ON news_signals (model, prompt_version, review_decision)
  WHERE reviewed_at IS NOT NULL;

CREATE TRIGGER trg_news_signals_set_updated_at
  BEFORE UPDATE ON news_signals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Extraction bookkeeping on the article itself, so the job can tell "not
-- extracted yet" from "extracted and yielded nothing". Without it, an article
-- the model correctly found no signal in would be retried on every run,
-- forever, at full cost.
ALTER TABLE news_items
  ADD COLUMN signals_extracted_at timestamptz,
  ADD COLUMN signals_model text;

CREATE INDEX news_items_pending_extraction_idx ON news_items (source, published_at)
  WHERE body IS NOT NULL AND signals_extracted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON news_signals TO app_rw;
GRANT SELECT ON news_signals TO app_ro;

COMMENT ON TABLE news_signals IS 'Structured price signals extracted from article text. reviewed_at IS NULL is the human review queue; nothing user-facing may read an unreviewed row.';
COMMENT ON COLUMN news_signals.cohort IS 'Predicate form of a target, e.g. {"playstyle":"Rapid"} — a gameplay change reprices every card carrying the trait, which a card-only model cannot express.';
COMMENT ON COLUMN news_signals.confidence IS 'The extractor''s own confidence, distinct from the reviewer''s verdict — a confidently wrong signal is the failure mode worth counting.';
COMMENT ON COLUMN news_signals.rationale IS 'For a reviewer judging the extraction. Never shown to users as advice.';
COMMENT ON COLUMN news_items.signals_extracted_at IS 'Set once extraction has run, even when it found nothing — otherwise a signal-free article is re-extracted forever at full cost.';
