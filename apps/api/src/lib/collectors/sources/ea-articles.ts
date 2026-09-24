// EA article bodies — the text Phase D's extraction will read.
//
// Split from `ea.news` because the two have different discovery rules and
// very different request budgets. The index is a handful of pages fetched
// every run; bodies are one request per article, ~72 of them today and
// growing, and almost all of them never change again once published.
//
// So this adapter is a *queue drainer*: `ea.news` records that an article
// exists, this fills in its body, and `news_items.body IS NULL` is the work
// list (backed by `news_items_pending_body_idx`). A capped batch per run
// means a first sync spreads over a few runs instead of becoming a 72-request
// burst — which is the same politeness argument as everywhere else, applied
// to volume rather than rate.
//
// An article whose body is already stored is never re-fetched. EA does edit
// posts occasionally, but re-reading 72 unchanged articles hourly to catch
// that would cost far more than it is worth; a deliberate re-sync can clear
// bodies to re-queue them.

import { newsItems } from '@sl/db';
import { and, eq, isNull } from 'drizzle-orm';

import { defineSource, type ParseFailure } from '../types.js';

import { dig, extractNextData } from './ea-news.js';

/** Bodies fetched per run. At the adapter's 3s spacing this is a little over
 * a minute of polite work, and a first sync converges in a handful of runs. */
const BATCH = 15;

export interface EaArticleBody {
  body: string;
  publishedAt: string | null;
}

/** Pulled out so it can be tested against a stored page with no network. */
export function parseEaArticle(html: string): {
  article: EaArticleBody | null;
  failure: string | null;
} {
  const { data, failure } = extractNextData(html);
  if (failure) return { article: null, failure };

  // The detail page carries the article under `articleDetailsFallback` —
  // the same payload the client would otherwise fetch separately.
  const details = dig(data, ['props', 'pageProps', 'articleDetailsFallback']);
  if (typeof details !== 'object' || details === null) {
    return {
      article: null,
      failure: 'articleDetailsFallback missing — article page shape changed',
    };
  }

  const record = details as Record<string, unknown>;
  const body = record.body;
  if (typeof body !== 'string' || body.trim() === '') {
    return { article: null, failure: 'article payload carried no body text' };
  }

  return {
    article: {
      body,
      publishedAt: typeof record.publishingDate === 'string' ? record.publishingDate : null,
    },
    failure: null,
  };
}

export default defineSource({
  source: 'ea',
  job: 'ea.articles',
  minIntervalMs: 3000,
  maxDocumentsPerRun: BATCH,
  // The body is extracted and stored in `news_items`; a second copy of the
  // surrounding 380KB page adds nothing but table growth.
  storeRawBodies: false,

  async discover(ctx) {
    const pending = await ctx.db
      .select({ url: newsItems.url })
      .from(newsItems)
      .where(and(eq(newsItems.source, 'ea'), isNull(newsItems.body)))
      .limit(BATCH);

    return pending.map((row) => ({ url: row.url }));
  },

  // The detail page has the same Next.js wrapper churn as the index, so
  // change detection hashes the article text rather than the page around it.
  canonicalise(body) {
    const { article } = parseEaArticle(body);
    return article ? article.body : null;
  },

  async parse(doc, ctx) {
    const { article, failure } = parseEaArticle(doc.body);
    if (!article) {
      return { failures: [{ url: doc.url, reason: failure ?? 'unparseable article' }] };
    }

    const failures: ParseFailure[] = [];
    const result = await ctx.db
      .update(newsItems)
      .set({
        body: article.body,
        publishedAt: article.publishedAt ? new Date(article.publishedAt) : undefined,
      })
      .where(and(eq(newsItems.source, 'ea'), eq(newsItems.url, doc.url)))
      .returning({ id: newsItems.id });

    if (result.length === 0) {
      // The URL was discovered from this very table, so finding no row means
      // something deleted it mid-run — worth recording rather than ignoring.
      failures.push({ url: doc.url, reason: 'no news_items row matched this article url' });
      return { failures };
    }

    ctx.log.info(
      { source: 'ea', job: 'ea.articles', chars: article.body.length },
      'article body stored',
    );
    return { failures, rowsWritten: result.length };
  },
});
