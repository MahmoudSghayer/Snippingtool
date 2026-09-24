// Article body parsing, against a fixture captured from a real EA article
// page — so a page-shape change is caught here rather than showing up as a
// collector that quietly stops filling bodies.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseEaArticle } from '../sources/ea-articles.js';

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ea-article.html'),
  'utf8',
);

describe('parseEaArticle', () => {
  it('extracts the body from a real article page', () => {
    const { article, failure } = parseEaArticle(fixture);

    expect(failure).toBeNull();
    expect(article).not.toBeNull();
    expect(article!.body.length).toBeGreaterThan(100);
    expect(article!.publishedAt).toBeTruthy();
  });

  it('reports a failure when articleDetailsFallback is gone', () => {
    // The realistic regression: EA moves the article payload, and the body
    // queue silently stops draining.
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({ props: { pageProps: {} } }) +
      '</script>';
    const { article, failure } = parseEaArticle(html);
    expect(article).toBeNull();
    expect(failure).toMatch(/articleDetailsFallback/);
  });

  it('treats an empty body as a failure, not as a fetched article', () => {
    // Storing '' would mark the item done and drop it off the work queue
    // forever, which is worse than retrying.
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({ props: { pageProps: { articleDetailsFallback: { body: '   ' } } } }) +
      '</script>';
    const { article, failure } = parseEaArticle(html);
    expect(article).toBeNull();
    expect(failure).toMatch(/no body text/);
  });

  it('reports a failure on a page with no payload at all', () => {
    const { failure } = parseEaArticle('<html><body>gated</body></html>');
    expect(failure).toMatch(/__NEXT_DATA__/);
  });

  it('tolerates a missing publishing date', () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: { pageProps: { articleDetailsFallback: { body: 'real text here' } } },
      }) +
      '</script>';
    const { article, failure } = parseEaArticle(html);
    expect(failure).toBeNull();
    expect(article!.publishedAt).toBeNull();
  });
});
