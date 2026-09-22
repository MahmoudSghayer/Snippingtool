// The politeness guarantees, exercised against a stub fetch.
//
// These are the behaviours docs/14-ml-suggestions.md §4e commits to, and the
// ones that are invisible when they regress — nothing fails loudly if the
// rate limiter stops limiting or robots stops being consulted, we just
// quietly become a worse citizen. Hence tests.

import { describe, expect, it, vi } from 'vitest';

import { detectChallenge, PoliteFetcher } from '../fetcher.js';

const ROBOTS_ALLOW = 'User-agent: *\nAllow: /\n';

/** A fetch stub that serves robots.txt plus a scripted set of responses, and
 * records call order/timing. */
function stubFetch(routes: Record<string, () => Response>, robots = ROBOTS_ALLOW) {
  const calls: { url: string; at: number }[] = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push({ url, at: Date.now() });
    if (url.endsWith('/robots.txt')) {
      return new Response(robots, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const noSleep = async () => {};

describe('PoliteFetcher — robots gate', () => {
  it('refuses a disallowed path without fetching it', async () => {
    const { impl, calls } = stubFetch(
      { 'https://x.test/blocked': () => new Response('secret', { status: 200 }) },
      'User-agent: *\nDisallow: /blocked\n',
    );
    const fetcher = new PoliteFetcher({ fetchImpl: impl, sleepImpl: noSleep, minIntervalMs: 0 });

    const out = await fetcher.fetch('https://x.test/blocked');

    expect(out.kind).toBe('disallowed');
    // robots.txt was fetched; the page itself never was.
    expect(calls.map((c) => c.url)).toEqual(['https://x.test/robots.txt']);
  });

  it('caches robots.txt rather than re-fetching per URL', async () => {
    const { impl, calls } = stubFetch({
      'https://x.test/a': () => new Response('a', { status: 200 }),
      'https://x.test/b': () => new Response('b', { status: 200 }),
    });
    const fetcher = new PoliteFetcher({ fetchImpl: impl, sleepImpl: noSleep, minIntervalMs: 0 });

    await fetcher.fetch('https://x.test/a');
    await fetcher.fetch('https://x.test/b');

    expect(calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1);
  });
});

describe('PoliteFetcher — change detection', () => {
  it('reports unchanged when the body hash matches what we already had', async () => {
    const { impl } = stubFetch({
      'https://x.test/p': () => new Response('same body', { status: 200 }),
    });
    const fetcher = new PoliteFetcher({ fetchImpl: impl, sleepImpl: noSleep, minIntervalMs: 0 });

    const first = await fetcher.fetch('https://x.test/p');
    expect(first.kind).toBe('fetched');
    const hash = first.kind === 'fetched' ? first.hash : '';

    const second = await fetcher.fetch('https://x.test/p', { knownHash: hash });
    expect(second.kind).toBe('unchanged');
  });

  it('treats a 304 as unchanged and sends the conditional header', async () => {
    const seen: (string | undefined)[] = [];
    const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response(ROBOTS_ALLOW, { status: 200 });
      seen.push(new Headers(init?.headers).get('if-none-match') ?? undefined);
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const fetcher = new PoliteFetcher({ fetchImpl: impl, sleepImpl: noSleep, minIntervalMs: 0 });
    const out = await fetcher.fetch('https://x.test/p', { etag: 'W/"abc"', knownHash: 'h' });

    expect(out.kind).toBe('unchanged');
    expect(seen).toEqual(['W/"abc"']);
  });
});

describe('PoliteFetcher — backing off rather than escalating', () => {
  it('treats 403 as terminal and does not retry it', async () => {
    let hits = 0;
    const { impl } = stubFetch({
      'https://x.test/p': () => {
        hits += 1;
        return new Response('nope', { status: 403 });
      },
    });
    const fetcher = new PoliteFetcher({
      fetchImpl: impl,
      sleepImpl: noSleep,
      minIntervalMs: 0,
      maxAttempts: 3,
    });

    const out = await fetcher.fetch('https://x.test/p');

    expect(out.kind).toBe('blocked');
    expect(hits).toBe(1); // a refusal is an answer, not a transient error
  });

  it('classifies a 200 challenge page as blocked, not as content', async () => {
    // Otherwise the interstitial HTML gets stored and parsed as if it were
    // data, which is how a collector silently starts producing nonsense.
    const { impl } = stubFetch({
      'https://x.test/p': () =>
        new Response('<html><head><title>Just a moment...</title></head></html>', { status: 200 }),
    });
    const fetcher = new PoliteFetcher({ fetchImpl: impl, sleepImpl: noSleep, minIntervalMs: 0 });

    const out = await fetcher.fetch('https://x.test/p');

    expect(out.kind).toBe('blocked');
    expect(out.kind === 'blocked' && out.reason).toMatch(/challenge/i);
  });

  it('retries a 5xx and succeeds if it recovers', async () => {
    let hits = 0;
    const { impl } = stubFetch({
      'https://x.test/p': () => {
        hits += 1;
        return hits < 3
          ? new Response('boom', { status: 503 })
          : new Response('ok', { status: 200 });
      },
    });
    const fetcher = new PoliteFetcher({
      fetchImpl: impl,
      sleepImpl: noSleep,
      minIntervalMs: 0,
      maxAttempts: 3,
    });

    const out = await fetcher.fetch('https://x.test/p');

    expect(out.kind).toBe('fetched');
    expect(hits).toBe(3);
  });

  it('gives up with an error once retries are exhausted', async () => {
    const { impl } = stubFetch({
      'https://x.test/p': () => new Response('boom', { status: 500 }),
    });
    const fetcher = new PoliteFetcher({
      fetchImpl: impl,
      sleepImpl: noSleep,
      minIntervalMs: 0,
      maxAttempts: 2,
    });

    const out = await fetcher.fetch('https://x.test/p');
    expect(out.kind).toBe('error');
  });
});

describe('PoliteFetcher — pacing', () => {
  it('serialises same-host requests and waits between them', async () => {
    const slept: number[] = [];
    const { impl } = stubFetch({
      'https://x.test/a': () => new Response('a', { status: 200 }),
      'https://x.test/b': () => new Response('b', { status: 200 }),
    });
    const fetcher = new PoliteFetcher({
      fetchImpl: impl,
      sleepImpl: async (ms) => {
        slept.push(ms);
      },
      minIntervalMs: 2000,
    });

    // Issued concurrently: the fetcher, not the caller, is responsible for
    // spacing them.
    await Promise.all([fetcher.fetch('https://x.test/a'), fetcher.fetch('https://x.test/b')]);

    expect(slept.some((ms) => ms > 0)).toBe(true);
  });

  it('keeps the host queue alive after a failed request', async () => {
    let first = true;
    const impl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/robots.txt')) return new Response(ROBOTS_ALLOW, { status: 200 });
      if (first) {
        first = false;
        throw new Error('socket hang up');
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const fetcher = new PoliteFetcher({
      fetchImpl: impl,
      sleepImpl: noSleep,
      minIntervalMs: 0,
      maxAttempts: 1,
    });

    const bad = await fetcher.fetch('https://x.test/a');
    expect(bad.kind).toBe('error');

    // A wedged chain here would hang forever rather than fail.
    const good = await fetcher.fetch('https://x.test/b');
    expect(good.kind).toBe('fetched');
  });
});

describe('detectChallenge', () => {
  it('recognises the common interstitials and passes real content through', () => {
    expect(detectChallenge('<title>Just a moment...</title>')).toMatch(/challenge/i);
    expect(detectChallenge('Attention Required! | Cloudflare')).toMatch(/challenge/i);
    expect(detectChallenge('<html><body>Enable JavaScript and cookies to continue</body>')).toMatch(
      /challenge/i,
    );
    expect(detectChallenge('{"items":[{"title":"real content"}]}')).toBeNull();
  });
});
