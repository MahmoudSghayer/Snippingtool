// Market intelligence tables (docs/14-ml-suggestions.md Phase A): canonical
// card identity, per-source aliases, the price time series, and the
// collector's own bookkeeping.
//
// Mirrors migrations/0027_market_intelligence.sql. As everywhere else in this
// package, the SQL is the source of truth for DDL and this file is the typed
// query layer over it (docs/02-database.md "Why Drizzle is query-only") — so
// the enum value lists below must stay byte-for-byte identical to the
// CREATE TYPE statements in that migration.

import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  collectorRunStatusEnum,
  createdAt,
  eventDateConfidenceEnum,
  marketEventKindEnum,
  newsKindEnum,
  marketPlatformEnum,
  marketSourceEnum,
  priceKindEnum,
  rowVersion,
  timestamptz,
  updatedAt,
} from './common.js';

// ---------------------------------------------------------------------------
// cards — canonical identity. Keyed on EA's resource_id because that is the
// only id the extension can observe in the wild; `fcTitle` is part of the key
// because resource ids are reused across titles.
// ---------------------------------------------------------------------------

export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    resourceId: text('resource_id').notNull(),
    fcTitle: text('fc_title').notNull(),

    name: text('name').notNull(),
    commonName: text('common_name'),
    rating: integer('rating'),
    position: text('position'),
    cardVersion: text('card_version'),

    clubId: integer('club_id'),
    leagueId: integer('league_id'),
    nationId: integer('nation_id'),

    /** Free-form traits (playstyles, roles), queried as cohort predicates — a
     * playstyle nerf reprices every card carrying it. */
    attributes: jsonb('attributes').notNull().default({}),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rowVersion: rowVersion(),
  },
  (t) => [index('cards_rating_idx').on(t.rating)],
);

// ---------------------------------------------------------------------------
// card_source_ids — how each source names a card.
//
// `confidence` is here because matching scraped rows and news text to a card
// is often a guess: anything below threshold with `reviewedAt` null is a
// human review queue item, not a fact.
// ---------------------------------------------------------------------------

export const cardSourceIds = pgTable(
  'card_source_ids',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    source: marketSourceEnum('source').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url'),

    /** numeric(4,3) — kept as text by drizzle's numeric mode to avoid silent
     * float rounding, same convention as risk_budget_events.value. */
    confidence: numeric('confidence').notNull().default('1.000'),
    resolvedBy: text('resolved_by').notNull().default('exact'),
    reviewedAt: timestamptz('reviewed_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('card_source_ids_card_id_idx').on(t.cardId)],
);

export const cardSourceIdsRelations = relations(cardSourceIds, ({ one }) => ({
  card: one(cards, { fields: [cardSourceIds.cardId], references: [cards.id] }),
}));

export const cardsRelations = relations(cards, ({ many }) => ({
  sourceIds: many(cardSourceIds),
}));

// ---------------------------------------------------------------------------
// price_observations — the time series, partitioned by month on observed_at
// (same shape as sniping_activity, so the composite PK carries the partition
// key). Intentionally not unique per (card, source, platform, kind, time):
// two sources disagreeing is signal to keep, not a conflict to suppress.
// ---------------------------------------------------------------------------

export const priceObservations = pgTable(
  'price_observations',
  {
    id: uuid('id').notNull().defaultRandom(),

    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    source: marketSourceEnum('source').notNull(),
    platform: marketPlatformEnum('platform').notNull(),
    priceKind: priceKindEnum('price_kind').notNull().default('lowest_bin'),

    price: integer('price').notNull(),
    /** The collector run that produced this row, so a bad parse can be
     * retracted as a unit rather than by guessing at timestamps. */
    runId: uuid('run_id'),

    observedAt: timestamptz('observed_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.observedAt] }),
    index('price_observations_card_idx').on(t.cardId, t.platform, t.observedAt),
    index('price_observations_source_idx').on(t.source, t.observedAt),
    index('price_observations_run_idx').on(t.runId),
  ],
);

export const priceObservationsRelations = relations(priceObservations, ({ one }) => ({
  card: one(cards, { fields: [priceObservations.cardId], references: [cards.id] }),
}));

// ---------------------------------------------------------------------------
// raw_documents — what the collector received, before parsing. Kept so a
// parser bug is replayable without re-fetching (and therefore without
// hammering a source to debug our own mistake); `contentHash` doubles as the
// change detector.
// ---------------------------------------------------------------------------

export const rawDocuments = pgTable(
  'raw_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    source: marketSourceEnum('source').notNull(),
    url: text('url').notNull(),
    contentHash: text('content_hash').notNull(),
    contentType: text('content_type'),
    httpStatus: integer('http_status'),
    byteSize: integer('byte_size'),
    body: text('body'),

    runId: uuid('run_id'),
    fetchedAt: timestamptz('fetched_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('raw_documents_source_fetched_idx').on(t.source, t.fetchedAt),
    index('raw_documents_url_idx').on(t.url, t.fetchedAt),
    index('raw_documents_run_idx').on(t.runId),
  ],
);

// ---------------------------------------------------------------------------
// collector_runs — one row per invocation. A collector that silently rots
// looks exactly like a quiet market, so this is what the health view reads.
// ---------------------------------------------------------------------------

export const collectorRuns = pgTable(
  'collector_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    source: marketSourceEnum('source').notNull(),
    job: text('job').notNull(),
    status: collectorRunStatusEnum('status').notNull().default('running'),

    documentsFetched: integer('documents_fetched').notNull().default(0),
    documentsChanged: integer('documents_changed').notNull().default(0),
    rowsWritten: integer('rows_written').notNull().default(0),
    parseFailures: integer('parse_failures').notNull().default(0),

    error: text('error'),
    /** Diagnostic only — pages visited, rate-limit waits, the robots
     * decision. Never read by application logic. */
    detail: jsonb('detail').notNull().default({}),

    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('collector_runs_source_started_idx').on(t.source, t.startedAt),
    index('collector_runs_status_idx').on(t.status, t.startedAt),
  ],
);

// ---------------------------------------------------------------------------
// news_items — the evidence Phase D extraction reads (0028).
//
// `body` is nullable because a listing and an article detail are two separate
// fetches: a row with a NULL body is a work queue, not a defect.
// ---------------------------------------------------------------------------

export const newsItems = pgTable(
  'news_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    source: marketSourceEnum('source').notNull(),
    kind: newsKindEnum('kind').notNull().default('news'),
    url: text('url').notNull(),
    slug: text('slug').notNull(),

    title: text('title').notNull(),
    summary: text('summary'),
    body: text('body'),

    fcTitle: text('fc_title'),
    publishedAt: timestamptz('published_at'),

    /** Of the body, so a re-fetch that changed nothing is a no-op and an
     * edited article shows up as a change rather than a silent overwrite. */
    contentHash: text('content_hash'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('news_items_published_idx').on(t.publishedAt),
    index('news_items_kind_idx').on(t.kind, t.publishedAt),
  ],
);

// ---------------------------------------------------------------------------
// market_events — the calendar (0028).
//
// Separate from news_items because an event is a *claim about the world*
// while a news item is a document we fetched: a classification can be revised
// or re-run without touching the evidence it came from.
// ---------------------------------------------------------------------------

export const marketEvents = pgTable(
  'market_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    newsItemId: uuid('news_item_id').references(() => newsItems.id, { onDelete: 'cascade' }),

    kind: marketEventKindEnum('kind').notNull().default('content'),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    sourceUrl: text('source_url'),

    /** Always known: when the announcement was published. */
    announcedAt: timestamptz('announced_at').notNull(),
    /** Known only when a source actually stated it — EA's promo articles
     * generally do not, so these stay null rather than being fabricated from
     * the publishing date. */
    startsAt: timestamptz('starts_at'),
    endsAt: timestamptz('ends_at'),
    dateConfidence: eventDateConfidenceEnum('date_confidence').notNull().default('announced'),

    fcTitle: text('fc_title'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('market_events_announced_idx').on(t.announcedAt),
    index('market_events_kind_idx').on(t.kind, t.announcedAt),
  ],
);

export const marketEventsRelations = relations(marketEvents, ({ one }) => ({
  newsItem: one(newsItems, { fields: [marketEvents.newsItemId], references: [newsItems.id] }),
}));
