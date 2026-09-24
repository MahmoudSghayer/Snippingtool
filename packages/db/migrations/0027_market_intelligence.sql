-- 0027_market_intelligence.sql
-- Phase A of docs/14-ml-suggestions.md: the identity spine every later phase
-- hangs off, the price time series, and the collector's own bookkeeping.
--
-- The ordering here is deliberate. Nothing downstream works until a price
-- scraped from one site, a price scraped from another, and a `resourceId`
-- seen by the extension all resolve to the *same* card — a series that
-- silently mixes two versions of the same player is worse than no series,
-- because it still looks plausible. So `cards` + `card_source_ids` come
-- first and everything references them.

-- ---------------------------------------------------------------------------
-- Enums. Mirrored byte-for-byte in src/schema/common.ts (Drizzle is a typed
-- query layer here, not the DDL source of truth — see docs/02-database.md).
-- ---------------------------------------------------------------------------

-- Every origin a row can come from, including ourselves. `first_party` is the
-- extension's own pooled observations (docs/14 Phase F): it shares this
-- table rather than getting its own so that cross-source agreement checks
-- treat it as just another opinion to reconcile.
CREATE TYPE market_source AS ENUM (
  'futbin',
  'futgg',
  'futwiz',
  'ea',
  'first_party'
);

-- Console and PC markets diverge materially; a series that mixes them is
-- meaningless, so platform is a dimension from day one rather than a later
-- migration that has to rewrite history.
CREATE TYPE market_platform AS ENUM ('console', 'pc');

-- What a given price actually means. Sources disagree on this: a "price" may
-- be the current lowest buy-now, or an end of a suggested range. Recording
-- which kind it is prevents comparing a floor against a ceiling and calling
-- the difference a market move.
CREATE TYPE price_kind AS ENUM ('lowest_bin', 'range_min', 'range_max', 'average');

CREATE TYPE collector_run_status AS ENUM ('running', 'success', 'partial', 'failed', 'skipped');

-- ---------------------------------------------------------------------------
-- cards — canonical card identity.
--
-- Keyed on EA's `resource_id` because that is the only id the extension can
-- observe in the wild; every third-party id is an alias onto it
-- (card_source_ids below). `fc_title` is part of the identity: resource ids
-- are reused across titles, so without it FC26 prices would silently append
-- to an FC25 series.
-- ---------------------------------------------------------------------------

CREATE TABLE cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  resource_id   text NOT NULL,
  fc_title      text NOT NULL,

  name          text NOT NULL,
  common_name   text,
  rating        integer,
  position      text,
  card_version  text,

  club_id       integer,
  league_id     integer,
  nation_id     integer,

  -- Free-form because sources disagree on the vocabulary and it is only ever
  -- read as a cohort predicate (docs/14 §6): a playstyle nerf reprices every
  -- card carrying it, so this needs to be queryable, not normalised.
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 0,

  CONSTRAINT cards_resource_id_fc_title_key UNIQUE (resource_id, fc_title),
  CONSTRAINT cards_rating_range CHECK (rating IS NULL OR (rating >= 0 AND rating <= 99))
);

CREATE INDEX cards_name_idx ON cards (lower(name));
CREATE INDEX cards_rating_idx ON cards (rating) WHERE rating IS NOT NULL;
CREATE INDEX cards_attributes_gin ON cards USING gin (attributes jsonb_path_ops);

CREATE TRIGGER trg_cards_set_updated_at
  BEFORE UPDATE ON cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_cards_bump_row_version
  BEFORE UPDATE ON cards
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();

-- ---------------------------------------------------------------------------
-- card_source_ids — how each source names a card.
--
-- `confidence` and `resolved_by` exist because matching a news headline or a
-- scraped row to a card is frequently a guess. Anything below the review
-- threshold is a queue item for a human, not a fact — and storing the
-- confidence is what makes that queue possible instead of silently trusting
-- a fuzzy match.
-- ---------------------------------------------------------------------------

CREATE TABLE card_source_ids (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  card_id       uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  source        market_source NOT NULL,
  external_id   text NOT NULL,
  url           text,

  confidence    numeric(4, 3) NOT NULL DEFAULT 1.000,
  resolved_by   text NOT NULL DEFAULT 'exact',
  reviewed_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT card_source_ids_source_external_key UNIQUE (source, external_id),
  CONSTRAINT card_source_ids_card_source_key UNIQUE (card_id, source),
  CONSTRAINT card_source_ids_confidence_range CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX card_source_ids_card_id_idx ON card_source_ids (card_id);
CREATE INDEX card_source_ids_review_idx ON card_source_ids (confidence)
  WHERE reviewed_at IS NULL;

CREATE TRIGGER trg_card_source_ids_set_updated_at
  BEFORE UPDATE ON card_source_ids
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- price_observations — the time series.
--
-- Partitioned by month on observed_at exactly like sniping_activity (0011):
-- append-mostly, queried by recency, and cheap to age out a whole month.
-- Deliberately NOT unique on (card, source, platform, kind, observed_at):
-- two collectors racing the same page should both land, and disagreement
-- between them is signal we want to keep rather than a conflict to suppress.
-- ---------------------------------------------------------------------------

CREATE TABLE price_observations (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),

  card_id       uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  source        market_source NOT NULL,
  platform      market_platform NOT NULL,
  price_kind    price_kind NOT NULL DEFAULT 'lowest_bin',

  price         integer NOT NULL,
  -- The collector run that produced this row, so a bad parse can be found
  -- and retracted as a unit instead of by guessing at timestamps.
  run_id        uuid,

  observed_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT price_observations_pkey PRIMARY KEY (id, observed_at),
  CONSTRAINT price_observations_price_nonneg CHECK (price >= 0)
) PARTITION BY RANGE (observed_at);

CREATE TABLE price_observations_default PARTITION OF price_observations DEFAULT;

CREATE INDEX price_observations_card_idx
  ON price_observations (card_id, platform, observed_at DESC);
CREATE INDEX price_observations_source_idx
  ON price_observations (source, observed_at DESC);
CREATE INDEX price_observations_run_idx
  ON price_observations (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX price_observations_observed_at_brin
  ON price_observations USING brin (observed_at);

-- ---------------------------------------------------------------------------
-- raw_documents — what the collector actually received, before parsing.
--
-- Stored so a parser bug is replayable without re-fetching (and therefore
-- without hammering a source to debug our own mistake). `content_hash` is
-- also the change detector: a fetch whose hash matches the last stored one
-- is recorded as unchanged and costs no parse and no downstream write.
-- ---------------------------------------------------------------------------

CREATE TABLE raw_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source        market_source NOT NULL,
  url           text NOT NULL,
  content_hash  text NOT NULL,
  content_type  text,
  http_status   integer,
  byte_size     integer,
  body          text,

  run_id        uuid,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT raw_documents_source_url_hash_key UNIQUE (source, url, content_hash)
);

CREATE INDEX raw_documents_source_fetched_idx ON raw_documents (source, fetched_at DESC);
CREATE INDEX raw_documents_url_idx ON raw_documents (url, fetched_at DESC);
CREATE INDEX raw_documents_run_idx ON raw_documents (run_id) WHERE run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- collector_runs — collector health.
--
-- A collector that silently rots looks exactly like a quiet market, which is
-- the most likely failure mode of this whole feature (docs/14 §14). These
-- rows are what the health view reads: last success per source, parse
-- failure rate, and whether anything was actually written.
-- ---------------------------------------------------------------------------

CREATE TABLE collector_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source            market_source NOT NULL,
  job               text NOT NULL,
  status            collector_run_status NOT NULL DEFAULT 'running',

  documents_fetched integer NOT NULL DEFAULT 0,
  documents_changed integer NOT NULL DEFAULT 0,
  rows_written      integer NOT NULL DEFAULT 0,
  parse_failures    integer NOT NULL DEFAULT 0,

  error             text,
  -- Free-form per-collector detail (pages visited, rate-limit waits, the
  -- robots decision) — diagnostic only, never read by application logic.
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,

  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collector_runs_counts_nonneg CHECK (
    documents_fetched >= 0 AND documents_changed >= 0
    AND rows_written >= 0 AND parse_failures >= 0
  )
);

CREATE INDEX collector_runs_source_started_idx ON collector_runs (source, started_at DESC);
CREATE INDEX collector_runs_status_idx ON collector_runs (status, started_at DESC);

-- ---------------------------------------------------------------------------
-- Partitions + grants
-- ---------------------------------------------------------------------------

SELECT create_month_partitions('price_observations', date_trunc('month', now())::date, 13);

GRANT SELECT, INSERT, UPDATE, DELETE ON cards TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON card_source_ids TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON price_observations TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON raw_documents TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON collector_runs TO app_rw;

GRANT SELECT ON cards TO app_ro;
GRANT SELECT ON card_source_ids TO app_ro;
GRANT SELECT ON price_observations TO app_ro;
GRANT SELECT ON raw_documents TO app_ro;
GRANT SELECT ON collector_runs TO app_ro;

COMMENT ON TABLE cards IS 'Canonical card identity keyed on EA resource_id + FC title. Every third-party id is an alias onto this via card_source_ids.';
COMMENT ON COLUMN cards.attributes IS 'Free-form card traits (playstyles, roles) read as cohort predicates — a playstyle nerf reprices every card carrying it.';
COMMENT ON TABLE card_source_ids IS 'Per-source alias for a card, with the confidence of the match; confidence below threshold and reviewed_at IS NULL is a human review queue item.';
COMMENT ON TABLE price_observations IS 'Price time series, one row per observation per source/platform/kind. Partitioned by month on observed_at. Intentionally not deduped — source disagreement is signal.';
COMMENT ON TABLE raw_documents IS 'Raw fetched payloads kept for replay, and content_hash change detection so an unchanged page costs no parse.';
COMMENT ON TABLE collector_runs IS 'One row per collector invocation. Source of the collector health view — a silently rotted collector looks like a quiet market.';
