-- 0028_market_events.sql
-- Phase C of docs/14-ml-suggestions.md: EA's own announcements, which are
-- the strongest available predictor of a price move. FUT prices are
-- overwhelmingly supply-driven by content releases, and the content calendar
-- is published in advance.
--
-- A note on what is deliberately NOT modelled here. EA's promo articles do
-- not state machine-readable start/end times — checked against real articles
-- while building this, not assumed — so `starts_at`/`ends_at` are nullable
-- and stay NULL until something actually knows them. The column that is
-- always populated is `announced_at`, which is a fact we observed. Inventing
-- a window from the publishing date would produce a calendar that looks
-- authoritative and is wrong, and every later phase would train on it.

CREATE TYPE news_kind AS ENUM ('news', 'pitch_notes');

-- What an announcement is *about*, as far as can be told structurally.
-- `content` is the honest catch-all for "EA announced something that puts
-- items into the game" — promo, campaign, SBC-driven event — without
-- claiming to know which. Phase D's extraction is what narrows it.
CREATE TYPE market_event_kind AS ENUM (
  'content',
  'season',
  'pitch_notes',
  'ratings_refresh',
  'other'
);

-- How the dates on an event were arrived at. Nothing downstream should treat
-- an announcement date as an event start, so the provenance travels with the
-- row rather than living in a comment somewhere.
CREATE TYPE event_date_confidence AS ENUM (
  'announced',  -- we know when it was published, nothing more
  'stated',     -- the source gave an explicit start/end
  'inferred'    -- derived by a model; always reviewable
);

-- ---------------------------------------------------------------------------
-- news_items — one row per article, the substrate Phase D reads.
--
-- `body` is nullable because the index listing and the article detail are two
-- different fetches: the index establishes that an article exists, a later
-- pass fills the body. A row with a NULL body is therefore a work queue, not
-- a defect.
-- ---------------------------------------------------------------------------

CREATE TABLE news_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source        market_source NOT NULL,
  kind          news_kind NOT NULL DEFAULT 'news',
  url           text NOT NULL,
  slug          text NOT NULL,

  title         text NOT NULL,
  summary       text,
  body          text,

  fc_title      text,
  published_at  timestamptz,

  -- Of the body, so a re-fetch that changed nothing is a no-op and an edited
  -- article is visible as a change rather than silently overwritten.
  content_hash  text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT news_items_source_slug_key UNIQUE (source, slug)
);

CREATE INDEX news_items_published_idx ON news_items (published_at DESC NULLS LAST);
CREATE INDEX news_items_kind_idx ON news_items (kind, published_at DESC NULLS LAST);
-- The work queue: articles seen in a listing whose body has not been fetched.
CREATE INDEX news_items_pending_body_idx ON news_items (source, created_at)
  WHERE body IS NULL;

CREATE TRIGGER trg_news_items_set_updated_at
  BEFORE UPDATE ON news_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- market_events — the calendar.
--
-- One row per announcement that plausibly moves the market. Derived from
-- news_items, and kept separate from them because an event is a claim about
-- the world while a news item is a document we fetched: the classification
-- can be revised, re-run or corrected without touching the evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE market_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  news_item_id     uuid REFERENCES news_items(id) ON DELETE CASCADE,

  kind             market_event_kind NOT NULL DEFAULT 'content',
  title            text NOT NULL,
  slug             text NOT NULL,
  source_url       text,

  -- Always known: when the announcement was published.
  announced_at     timestamptz NOT NULL,
  -- Known only when something actually said so. See the header note.
  starts_at        timestamptz,
  ends_at          timestamptz,
  date_confidence  event_date_confidence NOT NULL DEFAULT 'announced',

  fc_title         text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT market_events_slug_key UNIQUE (slug),
  CONSTRAINT market_events_window_ordered CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at
  ),
  -- A 'stated' or 'inferred' date claim has to actually carry a date, or the
  -- confidence label is decoration.
  CONSTRAINT market_events_confidence_has_dates CHECK (
    date_confidence = 'announced' OR starts_at IS NOT NULL
  )
);

CREATE INDEX market_events_announced_idx ON market_events (announced_at DESC);
CREATE INDEX market_events_kind_idx ON market_events (kind, announced_at DESC);
CREATE INDEX market_events_starts_idx ON market_events (starts_at)
  WHERE starts_at IS NOT NULL;

CREATE TRIGGER trg_market_events_set_updated_at
  BEFORE UPDATE ON market_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON news_items TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON market_events TO app_rw;
GRANT SELECT ON news_items TO app_ro;
GRANT SELECT ON market_events TO app_ro;

COMMENT ON TABLE news_items IS 'Articles fetched from a source, the evidence Phase D extraction reads. A NULL body means the listing was seen but the article detail has not been fetched yet — a work queue, not a defect.';
COMMENT ON TABLE market_events IS 'Announcements that plausibly move the market, derived from news_items. Kept separate so a classification can be revised without touching the evidence it came from.';
COMMENT ON COLUMN market_events.announced_at IS 'When the announcement was published. Always known — unlike starts_at, which stays NULL until a source actually states it.';
COMMENT ON COLUMN market_events.date_confidence IS 'announced = publication date only; stated = the source gave explicit dates; inferred = derived by a model and reviewable.';
