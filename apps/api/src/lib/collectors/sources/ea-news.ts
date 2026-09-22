// EA's own FC news index — the content calendar (docs/14-ml-suggestions.md
// Phase C).
//
// EA is the highest-signal source available and the only one that answers us
// normally. FUT prices are overwhelmingly supply-driven by content releases,
// and EA announces those in advance, so this listing *is* the calendar.
//
// Parsing target: the page is a Next.js app, so the article list is already
// structured JSON in `__NEXT_DATA__`. Far more stable than scraping rendered
// markup — styling changes constantly, while this payload is the page's own
// data contract with itself.
//
// What this writes: one `news_items` row per article, plus a `market_events`
// row for the ones plausibly market-moving (ea-classify.ts decides,
// structurally and conservatively). Bodies are not fetched here — that is
// `ea.articles`, which works from the queue this leaves behind.

import { marketEvents, newsItems } from '@sl/db';

import { defineSource, type ParseFailure } from '../types.js';

import { classifyEaArticle, fcTitleFromSlug } from './ea-classify.js';

const NEWS_BASE = 'https://www.ea.com/games/ea-sports-fc/fc-26/news';

/** Articles per index page, as EA serves them. */
const PER_PAGE = 13;

/** Hard cap on index pages per run. EA reports ~72 articles today; this
 * leaves headroom without letting a payload change become a crawl. */
const MAX_PAGES = 8;

export function articleUrl(slug: string): string {
  return `${NEWS_BASE}/${slug}`;
}

const NEXT_DATA_RE =
  /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/;

/** Walks a path through unknown JSON without asserting `any` at each hop —
 * this payload is somebody else's data contract and can change shape under
 * us, so every level is checked rather than assumed. */
export function dig(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export interface EaNewsArticle {
  title: string;
  slug: string;
  type: string | null;
  publishingDate: string | null;
  summary: string | null;
  tags: string[];
}

/** Pulled out of the adapter so it can be tested against a stored page with
 * no network and no database. */
/** Both the index and the article detail are the same Next.js shell, so the
 * payload extraction is shared — a shape change breaks them together and
 * should be fixed in one place. */
export function extractNextData(html: string): { data: unknown; failure: string | null } {
  const match = NEXT_DATA_RE.exec(html);
  if (!match) {
    return {
      data: null,
      failure: 'no __NEXT_DATA__ block — page shape changed or content is gated',
    };
  }
  try {
    return { data: JSON.parse(match[1]!), failure: null };
  } catch (err) {
    return { data: null, failure: `__NEXT_DATA__ is not valid JSON: ${String(err)}` };
  }
}

export function parseEaNews(html: string): { articles: EaNewsArticle[]; failure: string | null } {
  const { data: payload, failure } = extractNextData(html);
  if (failure) return { articles: [], failure };

  const items = dig(payload, ['props', 'pageProps', 'initialNewsData', 'items']);
  if (!Array.isArray(items)) {
    return { articles: [], failure: 'initialNewsData.items missing or not an array' };
  }

  const articles: EaNewsArticle[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.title !== 'string' || typeof item.slug !== 'string') continue;
    articles.push({
      title: item.title,
      slug: item.slug,
      type: typeof item.type === 'string' ? item.type : null,
      publishingDate: typeof item.publishingDate === 'string' ? item.publishingDate : null,
      summary: typeof item.summary === 'string' ? item.summary : null,
      tags: Array.isArray(item.tags)
        ? item.tags.filter((t): t is string => typeof t === 'string')
        : [],
    });
  }

  // A structurally valid page with nothing in it is more likely our bug (or a
  // silent gate) than EA publishing an empty newsroom, so it is a failure
  // rather than an uneventful success.
  if (articles.length === 0) {
    return { articles, failure: 'news payload parsed but contained no usable articles' };
  }

  return { articles, failure: null };
}

export default defineSource({
  source: 'ea',
  job: 'ea.news',
  // EA is a large site that will not notice us, but there is no reason to
  // take more than we need: this index changes a few times a week.
  minIntervalMs: 3000,
  maxDocumentsPerRun: MAX_PAGES,
  // The index pages are ~450KB of markup whose useful content is extracted
  // into news_items; keeping a copy per page per run buys nothing.
  storeRawBodies: false,

  discover() {
    // Page count is fixed rather than derived, because discovery runs before
    // anything is fetched. Walking one page past the end is harmless — EA
    // returns the last page again and every write below is an idempotent
    // upsert.
    const pages = Math.min(Math.ceil(72 / PER_PAGE), MAX_PAGES);
    return Promise.resolve(
      Array.from({ length: pages }, (_, i) => ({
        url: i === 0 ? NEWS_BASE : `${NEWS_BASE}?page=${i + 1}`,
        meta: { page: i + 1 },
      })),
    );
  },

  // Measured, not assumed: two consecutive fetches of this page differ in
  // both length and hash, because the Next.js wrapper carries build and
  // session churn. Hashing the article list instead means the detector fires
  // on "EA published something", which is the only change that matters here.
  canonicalise(body) {
    const { articles } = parseEaNews(body);
    if (articles.length === 0) return null;
    return JSON.stringify(
      articles
        .map((a) => [a.slug, a.title, a.publishingDate])
        .sort((x, y) => x[0]!.localeCompare(y[0]!)),
    );
  },

  async parse(doc, ctx) {
    const { articles, failure } = parseEaNews(doc.body);
    const failures: ParseFailure[] = failure ? [{ url: doc.url, reason: failure }] : [];
    let rowsWritten = 0;

    for (const article of articles) {
      const { newsKind, eventKind, isMarketEvent } = classifyEaArticle(article);
      const publishedAt = article.publishingDate ? new Date(article.publishingDate) : null;
      const url = articleUrl(article.slug);
      const fcTitle = fcTitleFromSlug(article.slug);

      // Upsert on (source, slug): re-running the sweep must not duplicate,
      // and an edited title should land. `body` is deliberately untouched —
      // it belongs to ea.articles, and clearing it here would put a fetched
      // article back on that work queue forever.
      const [row] = await ctx.db
        .insert(newsItems)
        .values({
          source: 'ea',
          kind: newsKind,
          url,
          slug: article.slug,
          title: article.title,
          summary: article.summary,
          fcTitle,
          publishedAt,
        })
        .onConflictDoUpdate({
          target: [newsItems.source, newsItems.slug],
          set: { title: article.title, summary: article.summary, publishedAt },
        })
        .returning({ id: newsItems.id });

      rowsWritten += 1;
      if (!isMarketEvent || !row) continue;

      // `announced_at` is the publication date, which is a fact. `starts_at`
      // stays null: EA's promo posts do not state machine-readable windows,
      // and a fabricated one would look authoritative and be wrong.
      await ctx.db
        .insert(marketEvents)
        .values({
          newsItemId: row.id,
          kind: eventKind,
          title: article.title,
          slug: article.slug,
          sourceUrl: url,
          announcedAt: publishedAt ?? new Date(),
          dateConfidence: 'announced',
          fcTitle,
        })
        .onConflictDoUpdate({
          target: marketEvents.slug,
          set: { title: article.title, kind: eventKind },
        });
      rowsWritten += 1;
    }

    if (articles.length > 0) {
      ctx.log.info(
        { source: 'ea', job: 'ea.news', page: doc.meta?.page, articles: articles.length },
        'ea.news page parsed',
      );
    }

    return { failures, rowsWritten };
  },
});
