// EA's own FC news index.
//
// Phase A uses this as the framework's live proof: it is the one source that
// answers us normally, so it is what demonstrates discovery → robots check →
// conditional fetch → change detection → raw storage → run bookkeeping
// against a real server rather than a mock.
//
// It deliberately writes no domain rows yet. Turning these articles into
// `market_events` and `news_items` is Phase C (docs/14-ml-suggestions.md
// §13), and inventing those tables early to make this adapter look busier
// would be scope, not progress. What it does do is *validate* the payload —
// so a page that silently becomes an error shell, a redirect or a challenge
// is a parse failure here rather than a quietly successful run that stored
// nothing useful.
//
// Parsing target: the page is a Next.js app, so the article list is already
// structured JSON in `__NEXT_DATA__`. That is far more stable than scraping
// rendered HTML — markup gets restyled constantly, while this payload is the
// page's own data contract with itself.

import { defineSource, type ParseFailure } from '../types.js';

const NEWS_URL = 'https://www.ea.com/games/ea-sports-fc/fc-26/news';

const NEXT_DATA_RE =
  /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/;

/** Walks a path through unknown JSON without asserting `any` at each hop —
 * this payload is somebody else's data contract and can change shape under
 * us, so every level is checked rather than assumed. */
function dig(value: unknown, path: string[]): unknown {
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
export function parseEaNews(html: string): { articles: EaNewsArticle[]; failure: string | null } {
  const match = NEXT_DATA_RE.exec(html);
  if (!match) {
    return {
      articles: [],
      failure: 'no __NEXT_DATA__ block — page shape changed or content is gated',
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(match[1]!);
  } catch (err) {
    return { articles: [], failure: `__NEXT_DATA__ is not valid JSON: ${String(err)}` };
  }

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
  maxDocumentsPerRun: 5,

  discover() {
    return Promise.resolve([{ url: NEWS_URL }]);
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

  parse(doc, ctx) {
    const { articles, failure } = parseEaNews(doc.body);
    const failures: ParseFailure[] = failure ? [{ url: doc.url, reason: failure }] : [];

    if (articles.length > 0) {
      ctx.log.info(
        { source: 'ea', job: 'ea.news', articles: articles.length, latest: articles[0]?.title },
        'ea.news parsed',
      );
    }

    // No prices, no cards: Phase C owns turning these into market_events and
    // news_items. The run still records the fetch, the change detection and
    // any parse failure, which is what Phase A needs to prove.
    return { failures };
  },
});
