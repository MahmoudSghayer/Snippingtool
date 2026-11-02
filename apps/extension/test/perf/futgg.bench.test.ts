// The fut.gg layer: a cold hub read (fetch + parse), warm reads, what
// concurrent callers cost in requests, and adding 20 Sets' lineups.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleFutggLineup, handleFutggSets, resetFutggCache } from '../../src/background/futgg.js';
import { setFetchImpl } from '../../src/lib/http.js';

import { makeHubJson, makePoolJson, makeTagsJson } from './fixtures.js';
import { createSuite } from './harness.js';

const suite = createSuite('futgg');
afterAll(() => suite.flush());

const SETS = 250;
let fetches: string[] = [];

function serve(): void {
  const hub = JSON.stringify(makeHubJson(SETS));
  const tags = JSON.stringify(makeTagsJson());
  setFetchImpl(async (url) => {
    fetches.push(url);
    const path = new URL(url).pathname;
    if (path.endsWith('/hub/')) return new Response(hub, { status: 200 });
    const pool = /\/sets\/(\d+)\/pool\/$/.exec(path);
    if (pool) return new Response(JSON.stringify(makePoolJson(Number(pool[1]) - 1000)), { status: 200 });
    if (/\/sets\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(path)) return new Response(tags, { status: 200 });
    return new Response('', { status: 404 });
  });
}

beforeEach(async () => {
  fetches = [];
  await resetFutggCache();
  serve();
});
afterEach(() => setFetchImpl((input, init) => fetch(input, init)));

describe('fut.gg hub and lineups', () => {
  it('cold and warm Sets reads, and concurrent callers', async () => {
    await suite.benchAsync(
      `futggSets cold (${SETS} Sets)`,
      async () => {
        await resetFutggCache();
        fetches = [];
        const r = await handleFutggSets();
        expect(r.sets?.length).toBe(SETS);
        return { fetches: fetches.length };
      },
      { runs: 3, warmup: 0 },
    );
    await suite.benchAsync('futggSets warm', async () => {
      fetches = [];
      await handleFutggSets();
      return { fetches: fetches.length };
    });
    await suite.benchAsync(
      'futggSets 5 concurrent callers (cold)',
      async () => {
        await resetFutggCache();
        fetches = [];
        await Promise.all(Array.from({ length: 5 }, () => handleFutggSets()));
        return { fetches: fetches.length };
      },
      { runs: 2, warmup: 0 },
    );
  }, 120_000);

  it('20 lineups, sequential (as the page adds them)', async () => {
    const r = await suite.benchAsync(
      'futggLineup x20 cold',
      async () => {
        await resetFutggCache();
        fetches = [];
        let cards = 0;
        for (let i = 0; i < 20; i++) cards += (await handleFutggLineup({ setId: 1000 + i, grade: 'S' })).lineup?.cards.length ?? 0;
        return { fetches: fetches.length, cards };
      },
      { runs: 2, warmup: 0 },
    );
    expect(r.meta?.cards).toBe(300);
    await suite.benchAsync('futggLineup same Set again (warm)', async () => {
      fetches = [];
      await handleFutggLineup({ setId: 1000, grade: 'A' });
      return { fetches: fetches.length };
    });
  }, 120_000);
});
