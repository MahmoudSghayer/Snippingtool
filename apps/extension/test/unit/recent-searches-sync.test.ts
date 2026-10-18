// The Nova AI page's Recent searches log is the account's: content keeps a
// local copy and syncs it through background (content/recent-searches.ts),
// and background reads and replaces the account's copy
// (background/recent-searches.ts, /api/v1/extension/recent-searches).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleRecentSearchesGet, handleRecentSearchesSet } from '../../src/background/recent-searches.js';
import {
  RECENT_SEARCHES_KEY,
  RECENT_SEARCHES_MIGRATED_KEY,
  RECENT_SEARCHES_PUSH_DELAY_MS,
  createRecentSearchesSync,
  forAccount,
} from '../../src/content/recent-searches.js';
import { clearTokens } from '../../src/lib/auth.js';
import { blankForm, type RecentSearch } from '../../src/ui/bot-page.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type { RecentSearchesResponse } from '@sl/shared';

const deJong = { id: 228702, name: 'Frenkie de Jong', rating: 86 };
const entry = (at: number, maxBuy: number): RecentSearch => ({
  at,
  name: `86 Frenkie de Jong, max ${maxBuy}`,
  form: { ...blankForm(), player: deJong, maxBuy },
});
const listed = (items: RecentSearch[]): RecentSearchesResponse => ({ items, updatedAt: '2026-10-18T10:00:00.000Z' });

/** The sync with in-memory storage and a fake background: `account` is what
 * `recentSearches.get` answers (null: signed out or offline), and a
 * `recentSearches.set` replaces it unless `pushFails`. */
function harness(init: { account?: RecentSearchesResponse | null; local?: unknown; migrated?: boolean } = {}) {
  const store = new Map<string, unknown>();
  if (init.local !== undefined) store.set(RECENT_SEARCHES_KEY, init.local);
  if (init.migrated) store.set(RECENT_SEARCHES_MIGRATED_KEY, true);
  const state = { account: init.account ?? null, pushFails: false };
  const calls: string[] = [];
  const pushes: unknown[][] = [];
  const send = vi.fn(async (type: string, payload?: unknown) => {
    calls.push(type);
    if (type === 'recentSearches.get') return state.account;
    if (type === 'recentSearches.set') {
      const { items } = payload as { items: RecentSearch[] };
      pushes.push(items);
      if (state.pushFails) return null;
      state.account = listed(items);
      return state.account;
    }
    return null;
  });
  const sync = createRecentSearchesSync({
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => void store.set(key, value),
    },
    send: send as never,
  });
  return { sync, store, state, calls, pushes, local: () => store.get(RECENT_SEARCHES_KEY) };
}

describe('content/recent-searches.ts: load', () => {
  it("shows the account's list and keeps it as the local copy: the account wins", async () => {
    const h = harness({ account: listed([entry(2, 50_000), entry(1, 52_000)]), local: [entry(9, 1_000)], migrated: true });
    expect(await h.sync.load()).toEqual([entry(2, 50_000), entry(1, 52_000)]);
    expect(h.local()).toEqual([entry(2, 50_000), entry(1, 52_000)]);
    expect(h.pushes).toEqual([]);
  });

  it('shows the local copy while signed out or offline (background answers null), and keeps it', async () => {
    const h = harness({ account: null, local: [entry(1, 52_000)] });
    expect(await h.sync.load()).toEqual([entry(1, 52_000)]);
    expect(h.local()).toEqual([entry(1, 52_000)]);
    expect(h.store.has(RECENT_SEARCHES_MIGRATED_KEY)).toBe(false); // nothing reconciled yet
  });

  it('uploads the list this browser kept before sync, once, when the account has none', async () => {
    const before = [entry(2, 50_000), entry(1, 52_000)];
    const h = harness({ account: listed([]), local: before });

    expect(await h.sync.load()).toEqual(before);
    expect(h.pushes).toEqual([before]);
    expect(h.store.get(RECENT_SEARCHES_MIGRATED_KEY)).toBe(true);

    // The next load reads it back from the account, and uploads nothing.
    expect(await h.sync.load()).toEqual(before);
    expect(h.pushes).toHaveLength(1);

    // Another account with no list (signed in on the same browser later)
    // gets an empty list, not this browser's old one.
    h.state.account = listed([]);
    expect(await h.sync.load()).toEqual([]);
    expect(h.local()).toEqual([]);
    expect(h.pushes).toHaveLength(1);
  });

  it('uploads nothing when the account already has a list: it wins over the old local one', async () => {
    const h = harness({ account: listed([entry(5, 30_000)]), local: [entry(1, 52_000)] });
    expect(await h.sync.load()).toEqual([entry(5, 30_000)]);
    expect(h.pushes).toEqual([]);
    expect(h.local()).toEqual([entry(5, 30_000)]);
    expect(h.store.get(RECENT_SEARCHES_MIGRATED_KEY)).toBe(true);
  });

  it('tries the upload again on the next load when it did not reach the account', async () => {
    const before = [entry(1, 52_000)];
    const h = harness({ account: listed([]), local: before });
    h.state.pushFails = true;
    expect(await h.sync.load()).toEqual(before); // still shown, from the local copy
    expect(h.store.has(RECENT_SEARCHES_MIGRATED_KEY)).toBe(false);

    h.state.pushFails = false;
    expect(await h.sync.load()).toEqual(before);
    expect(h.pushes).toEqual([before, before]);
    expect(h.state.account?.items).toEqual(before);
  });

  it('uploads only the entries the account accepts', async () => {
    const h = harness({ account: listed([]), local: [entry(2, 20_000_000), entry(1, 52_000), 'junk'] });
    await h.sync.load();
    expect(h.pushes).toEqual([[entry(1, 52_000)]]);
  });
});

describe('content/recent-searches.ts: save', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the local copy at once, and the account once, after the last of several quick saves', async () => {
    const h = harness({ account: listed([]), migrated: true });
    await h.sync.save([entry(1, 52_000)]);
    await h.sync.save([entry(2, 50_000), entry(1, 52_000)]);
    expect(h.local()).toEqual([entry(2, 50_000), entry(1, 52_000)]);
    expect(h.pushes).toEqual([]);

    await vi.advanceTimersByTimeAsync(RECENT_SEARCHES_PUSH_DELAY_MS);
    expect(h.pushes).toEqual([[entry(2, 50_000), entry(1, 52_000)]]);
    expect(h.state.account?.items).toEqual([entry(2, 50_000), entry(1, 52_000)]);
  });

  it('never waits on the account, and a failed upload changes nothing locally', async () => {
    const h = harness({ account: null });
    let release: () => void = () => undefined;
    const send = vi.fn((type: string) =>
      type === 'recentSearches.set' ? new Promise<null>((resolve) => (release = () => resolve(null))) : Promise.resolve(null),
    );
    const sync = createRecentSearchesSync({
      storage: { get: async (key) => h.store.get(key), set: async (key, value) => void h.store.set(key, value) },
      send: send as never,
    });

    await sync.save([entry(1, 52_000)]); // resolves with the upload not even sent
    await vi.advanceTimersByTimeAsync(RECENT_SEARCHES_PUSH_DELAY_MS);
    expect(send).toHaveBeenCalledWith('recentSearches.set', { items: [entry(1, 52_000)] });
    release();
    expect(h.local()).toEqual([entry(1, 52_000)]);

    const failing = createRecentSearchesSync({
      storage: { get: async () => undefined, set: async () => undefined },
      send: (async () => {
        throw new Error('extension context invalidated');
      }) as never,
    });
    await failing.save([entry(1, 52_000)]);
    await vi.advanceTimersByTimeAsync(RECENT_SEARCHES_PUSH_DELAY_MS); // no unhandled rejection
  });

  it('keeps an entry the account would refuse in the local copy only', async () => {
    const h = harness({ account: listed([]), migrated: true });
    await h.sync.save([entry(2, 20_000_000), entry(1, 52_000)]);
    await vi.advanceTimersByTimeAsync(RECENT_SEARCHES_PUSH_DELAY_MS);
    expect(h.local()).toEqual([entry(2, 20_000_000), entry(1, 52_000)]);
    expect(h.pushes).toEqual([[entry(1, 52_000)]]);
  });

  it('a load sends a save still waiting before it reads the account, so the save is not lost', async () => {
    const h = harness({ account: listed([entry(1, 52_000)]), migrated: true });
    await h.sync.save([entry(3, 40_000), entry(1, 52_000)]);
    expect(await h.sync.load()).toEqual([entry(3, 40_000), entry(1, 52_000)]);
    expect(h.calls).toEqual(['recentSearches.set', 'recentSearches.get']);

    await vi.advanceTimersByTimeAsync(RECENT_SEARCHES_PUSH_DELAY_MS);
    expect(h.pushes).toHaveLength(1); // the timer no longer sends it twice
  });
});

describe('forAccount', () => {
  it('keeps what the shared schema accepts, as is, and drops the rest', () => {
    const ok = entry(1, 52_000);
    expect(forAccount([ok, { ...ok, extra: 1 }, { ...ok, at: 'x' }, null])).toEqual([ok]);
  });
});

// ---- background ------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('background/recent-searches.ts', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await clearTokens();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function signIn(): Promise<void> {
    const { setSession } = await import('../../src/lib/storage.js');
    await setSession('sl.accessToken', 'access-token');
  }

  it('answers null while signed out, without a request', async () => {
    expect(await handleRecentSearchesGet()).toBeNull();
    expect(await handleRecentSearchesSet({ items: [] })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the account's list with the user's token, and re-validates it", async () => {
    await signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, listed([entry(1, 52_000)])));
    expect(await handleRecentSearchesGet()).toEqual(listed([entry(1, 52_000)]));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test.local/api/v1/extension/recent-searches');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-token');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ at: 1 }], updatedAt: null }));
    expect(await handleRecentSearchesGet()).toBeNull();
  });

  it('replaces the list with a PUT of exactly the items', async () => {
    await signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, listed([entry(1, 52_000)])));
    expect(await handleRecentSearchesSet({ items: [entry(1, 52_000)] })).toEqual(listed([entry(1, 52_000)]));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test.local/api/v1/extension/recent-searches');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ items: [entry(1, 52_000)] });
  });

  it('answers null when the API cannot be reached (content uses its copy), and throws when it refuses', async () => {
    await signIn();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await handleRecentSearchesGet()).toBeNull();
    expect(await handleRecentSearchesSet({ items: [] })).toBeNull();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(400, { code: 'VALIDATION_FAILED', message: 'Request validation failed.' }));
    await expect(handleRecentSearchesSet({ items: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  }, 15_000);
});
