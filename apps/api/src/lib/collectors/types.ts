// The collector contract.
//
// Every source implements the same two-stage shape — `discover()` says what
// to fetch, `parse()` turns one fetched document into rows — and knows
// nothing about HTTP, robots, rate limiting, storage or run bookkeeping. That
// boundary is what lets a source be disabled by a feature toggle, or dropped
// entirely, without touching anything downstream (docs/14-ml-suggestions.md
// §4e/§7).
//
// The split also makes parsers testable without network access, which matters
// more than usual here: the two primary price sources currently refuse
// automated access from this infrastructure, so their parsers are developed
// against stored fixtures and exercised offline.

import type { Database } from '@sl/db';

export type MarketSource = 'futbin' | 'futgg' | 'futwiz' | 'ea' | 'first_party';
export type MarketPlatform = 'console' | 'pc';
export type PriceKind = 'lowest_bin' | 'range_min' | 'range_max' | 'average';

/** One URL a collector wants fetched this run. */
export interface DiscoveredTarget {
  url: string;
  /** Opaque per-target hint passed back to `parse()` — e.g. which card a
   * price page belongs to, so the parser need not re-derive it from the URL. */
  meta?: Record<string, unknown>;
}

/** A price row a parser produced. `cardRef` is deliberately not a `cardId`:
 * parsers work in the source's own vocabulary and resolution to a canonical
 * card happens afterwards (resolver.ts), so a parser can never invent an
 * identity it has not earned. */
export interface ParsedPrice {
  cardRef: CardRef;
  platform: MarketPlatform;
  priceKind: PriceKind;
  price: number;
  observedAt?: Date;
}

/** How a source refers to a card, in its own terms. */
export interface CardRef {
  /** The source's own id, when it exposes one — the only reliable key. */
  externalId?: string;
  /** EA's resource id, when the source exposes it directly. Best case: an
   * exact match needing no fuzzy resolution at all. */
  resourceId?: string;
  /** Human name, for sources that give nothing better (news, leaks). Resolved
   * fuzzily and low-confidence — see resolver.ts. */
  name?: string;
  rating?: number;
  cardVersion?: string;
  url?: string;
}

/** A document a parser could not make sense of. Counted into
 * `collector_runs.parse_failures` rather than thrown, so one bad page does
 * not abandon the rest of a run. */
export interface ParseFailure {
  url: string;
  reason: string;
}

export interface ParseResult {
  prices?: ParsedPrice[];
  /** Cards the source described well enough to create/enrich canonical rows. */
  cards?: CardRef[];
  failures?: ParseFailure[];
}

export interface CollectorContext {
  db: Database;
  log: {
    info: (o: unknown, m?: string) => void;
    warn: (o: unknown, m?: string) => void;
    error: (o: unknown, m?: string) => void;
  };
}

export interface FetchedDocument {
  url: string;
  body: string;
  contentType: string | null;
  meta?: Record<string, unknown>;
}

export interface SourceAdapter {
  /** Matches the `market_source` enum. */
  source: MarketSource;
  /** Stable id for this collector within the source, e.g. `ea.news`. Written
   * to `collector_runs.job`. */
  job: string;
  /** Minimum gap between requests to this source, overriding the fetcher
   * default. Set it to what the source would consider unremarkable, not to
   * the fastest it will tolerate. */
  minIntervalMs?: number;
  /** Hard cap on documents per run, so a discovery bug cannot turn into a
   * thousand-request crawl. */
  maxDocumentsPerRun?: number;
  /** Whether bodies are worth persisting to `raw_documents` for replay.
   * Default true; set false for very large, low-value payloads. */
  storeRawBodies?: boolean;

  discover(ctx: CollectorContext): Promise<DiscoveredTarget[]>;
  parse(doc: FetchedDocument, ctx: CollectorContext): Promise<ParseResult> | ParseResult;

  /**
   * Reduce a raw body to just the part whose change actually matters, for
   * change detection.
   *
   * Without this, change detection hashes the whole response — which is
   * right for a static page and useless for a dynamic one. EA's news page,
   * for instance, differs byte-for-byte on every single fetch (build ids and
   * rotating wrapper content), so a whole-body hash reports "changed" every
   * time: the detector never fires, every poll re-parses, and a ~450KB body
   * is stored hourly forever.
   *
   * Return a stable projection of the content — the parsed article list, the
   * price rows — and the hash becomes a question about the data rather than
   * about the page around it. Returning null falls back to the body hash.
   */
  canonicalise?(body: string): string | null;
}

export function defineSource(adapter: SourceAdapter): SourceAdapter {
  return adapter;
}
