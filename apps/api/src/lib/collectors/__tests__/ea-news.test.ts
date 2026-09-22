// Parser tests against a fixture captured from the real EA news page, so a
// page-shape change is caught here rather than showing up as a collector that
// quietly stops finding anything.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import eaNews, { parseEaNews } from '../sources/ea-news.js';

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ea-news.html'),
  'utf8',
);

describe('parseEaNews', () => {
  it('extracts articles from the real page payload', () => {
    const { articles, failure } = parseEaNews(fixture);

    expect(failure).toBeNull();
    expect(articles.length).toBeGreaterThan(0);

    const first = articles[0]!;
    expect(first.title).toBeTruthy();
    expect(first.slug).toBeTruthy();
    expect(Array.isArray(first.tags)).toBe(true);
  });

  it('reports a failure when the __NEXT_DATA__ block is gone', () => {
    // The realistic regression: EA restyles the page, or serves us a shell.
    const { articles, failure } = parseEaNews('<html><body>nothing here</body></html>');
    expect(articles).toHaveLength(0);
    expect(failure).toMatch(/__NEXT_DATA__/);
  });

  it('reports a failure on malformed JSON rather than throwing', () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{not json</script>';
    const { failure } = parseEaNews(html);
    expect(failure).toMatch(/not valid JSON/);
  });

  it('reports a failure when the payload is structurally valid but empty', () => {
    // A quiet success here would be indistinguishable from "EA published
    // nothing", which is exactly the silent-rot failure mode.
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({ props: { pageProps: { initialNewsData: { items: [] } } } }) +
      '</script>';
    const { articles, failure } = parseEaNews(html);
    expect(articles).toHaveLength(0);
    expect(failure).toMatch(/no usable articles/);
  });

  it('skips malformed items without discarding the good ones', () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: {
          pageProps: {
            initialNewsData: {
              items: [{ nope: true }, { title: 'Real', slug: 'real', tags: ['fut', 42] }],
            },
          },
        },
      }) +
      '</script>';

    const { articles, failure } = parseEaNews(html);

    expect(failure).toBeNull();
    expect(articles).toHaveLength(1);
    expect(articles[0]!.title).toBe('Real');
    expect(articles[0]!.tags).toEqual(['fut']); // non-string tag dropped
  });
});

describe('ea-news canonicalise — change detection', () => {
  // The regression this guards against was found by running the collector for
  // real: two consecutive fetches of the live page differ in both length and
  // hash, so hashing the whole body reported "changed" every time — the
  // detector never fired and a ~450KB body would have been stored hourly.
  const wrap = (items: unknown[], filler: string) =>
    `<html><body>${filler}<script id="__NEXT_DATA__" type="application/json">` +
    JSON.stringify({ props: { pageProps: { initialNewsData: { items } } } }) +
    `</script>${filler}</body></html>`;

  const items = [
    { title: 'A', slug: 'a', publishingDate: '2026-09-01' },
    { title: 'B', slug: 'b', publishingDate: '2026-09-02' },
  ];

  it('is stable when only the surrounding markup churns', () => {
    const one = eaNews.canonicalise!(wrap(items, '<!-- build 111 -->'));
    const two = eaNews.canonicalise!(wrap(items, '<!-- build 222 rotating banner -->'));
    expect(one).not.toBeNull();
    expect(one).toBe(two);
  });

  it('is stable when the article order changes but the set does not', () => {
    const forward = eaNews.canonicalise!(wrap(items, ''));
    const reversed = eaNews.canonicalise!(wrap([...items].reverse(), ''));
    expect(forward).toBe(reversed);
  });

  it('changes when an article is actually published', () => {
    const before = eaNews.canonicalise!(wrap(items, ''));
    const after = eaNews.canonicalise!(
      wrap([...items, { title: 'C', slug: 'c', publishingDate: '2026-09-03' }], ''),
    );
    expect(after).not.toBe(before);
  });

  it('falls back to null when nothing parses, so the body hash is used', () => {
    expect(eaNews.canonicalise!('<html>no data</html>')).toBeNull();
  });
});
