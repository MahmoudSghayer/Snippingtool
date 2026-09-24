// The collector registry.
//
// Registration is explicit rather than directory-scanned: a market collector
// makes outbound requests to somebody else's servers, and that is not
// something a file appearing on disk should start doing by itself.
//
// `enabled` is the per-source kill switch. Phase A ships with the two
// primary price sources registered but disabled, because they currently
// refuse automated access from this infrastructure — see the note on each.
// Keeping them here rather than deleting them records the intent, and means
// enabling one is a one-line change plus a parser, not a rediscovery of why
// they are missing.

import eaArticles from './ea-articles.js';
import eaNews from './ea-news.js';

import type { SourceAdapter } from '../types.js';

export interface RegisteredSource extends SourceAdapter {
  enabled: boolean;
  /** Why a source is disabled, surfaced in logs and the health view so the
   * reason travels with the fact. */
  disabledReason?: string;
}

export const COLLECTOR_SOURCES: RegisteredSource[] = [
  { ...eaNews, enabled: true },
  // Drains the body queue ea.news leaves behind. Registered after it so a
  // first sweep records the articles before this tries to fetch them.
  { ...eaArticles, enabled: true },

  // FUTBIN and FUT.GG both sit behind an interstitial that refuses this
  // infrastructure outright — at the time of writing even `/robots.txt`
  // answers 403, so we cannot read their crawl rules, let alone their data.
  // docs/14-ml-suggestions.md §4e commits us to backing off and seeking
  // permitted access rather than escalating, so they stay disabled until
  // there is a route their operators would sanction. Their parsers are not
  // written yet on purpose: a parser for a page nobody has ever fetched is
  // untested code that only looks finished.
];

export function enabledSources(): RegisteredSource[] {
  return COLLECTOR_SOURCES.filter((s) => s.enabled);
}

export function sourceByJob(job: string): RegisteredSource | undefined {
  return COLLECTOR_SOURCES.find((s) => s.job === job);
}
