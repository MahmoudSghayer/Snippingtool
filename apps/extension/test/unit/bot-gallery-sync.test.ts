// Gallery mode's list follows the signed-in account: background keeps a
// local copy and the account's at /api/v1/extension/gallery
// (background/bot.ts), so a browser the trader signs in on (another PC, a
// cloud machine, after signing out and back in) shows which Sets are done
// and which are not.

import { EMPTY_GALLERY, GALLERY_LIMITS, type GalleryState, type GallerySyncResponse } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleBotGalleryGet, handleBotGallerySet } from '../../src/background/bot.js';
import { clearTokens } from '../../src/lib/auth.js';
import { getLocal, setLocal, setSession } from '../../src/lib/storage.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

const GALLERY_KEY = 'sl.bot.gallery.v1';
const PENDING_KEY = 'sl.bot.gallery.pending.v1';
const BASE_KEY = 'sl.bot.gallery.base.v1';
const SYNCED_KEY = 'sl.bot.gallery.synced.v1';
const SAVED_AT = '2026-10-21T07:00:00.000Z';

/** A list that has spent `spent`, with `completed` marked completed (each
 * at its id, as its time, so a test can tell where a time came from). */
const list = (spent: number, completed: number[] = []): GalleryState => ({
  ...EMPTY_GALLERY,
  spent,
  ...(completed.length > 0
    ? { completed, completedAt: Object.fromEntries(completed.map((id) => [String(id), id])) }
    : {}),
});
const onAccount = (state: GalleryState | null, updatedAt = SAVED_AT): GallerySyncResponse => ({
  state,
  updatedAt: state ? updatedAt : null,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('background/bot.ts: the Gallery list follows the account', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await clearTokens();
    await setLocal(GALLERY_KEY, null);
    await setLocal(PENDING_KEY, null);
    await setLocal(BASE_KEY, null);
    await setLocal(SYNCED_KEY, null);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    // Lets any upload still queued from the test finish.
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const signIn = () => setSession('sl.accessToken', 'access-token');
  /** The PUT bodies sent so far. */
  const puts = () =>
    fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);
  /** Answers GETs with `account` and PUTs with a save time. */
  const accountHolds = (account: GallerySyncResponse) =>
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? jsonResponse(200, { updatedAt: '2026-10-21T08:00:00.000Z' }) : jsonResponse(200, account),
    );

  it('uses this browser’s list while signed out, and sends nothing', async () => {
    await setLocal(GALLERY_KEY, list(100));
    expect(await handleBotGalleryGet()).toEqual(list(100));
    await handleBotGallerySet(list(200));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await getLocal(GALLERY_KEY, null)).toEqual(list(200));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts a new browser with the account’s list, completed Sets and all, and keeps it as its local copy', async () => {
    await signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(list(100, [90, 54]))));
    expect(await handleBotGalleryGet()).toEqual(list(100, [90, 54]));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test.local/api/v1/extension/gallery');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-token');
    expect(await getLocal(GALLERY_KEY, null)).toEqual(list(100, [90, 54]));
    expect(await getLocal(BASE_KEY, null)).toBe(SAVED_AT);
  });

  it('the account wins over an older local copy', async () => {
    await signIn();
    await setLocal(GALLERY_KEY, list(500));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(list(100, [90]))));
    expect(await handleBotGalleryGet()).toEqual(list(100, [90]));
    expect(puts()).toEqual([]);
  });

  it('uploads this browser’s list when the account has none yet', async () => {
    await signIn();
    await setLocal(GALLERY_KEY, list(500, [90]));
    accountHolds(onAccount(null));
    expect(await handleBotGalleryGet()).toEqual(list(500, [90]));
    await vi.waitFor(() => expect(puts()).toEqual([{ state: list(500, [90]) }]));
    await vi.waitFor(async () => expect(await getLocal(BASE_KEY, null)).toBe('2026-10-21T08:00:00.000Z'));
  });

  it('gives none to a new browser on an account that never saved one', async () => {
    await signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(null)));
    expect(await handleBotGalleryGet()).toBeNull();
    expect(puts()).toEqual([]);
  });

  it('falls back to the local copy when the account cannot be reached or refuses, and never overwrites it then', async () => {
    vi.useRealTimers(); // the API client's retry backoff
    await signIn();
    await setLocal(GALLERY_KEY, list(500));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await handleBotGalleryGet()).toEqual(list(500));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(500, { code: 'INTERNAL', message: 'Something went wrong.' }));
    expect(await handleBotGalleryGet()).toEqual(list(500));
    // Not "the account has none": the account may well hold a newer list.
    expect(puts()).toEqual([]);
  }, 15_000);

  it('saves here at once and to the account within 2 s: one upload for a burst, carrying the latest list', async () => {
    await signIn();
    accountHolds(onAccount(null));
    await handleBotGallerySet(list(100));
    await vi.advanceTimersByTimeAsync(500);
    await handleBotGallerySet(list(200));
    expect(await getLocal(GALLERY_KEY, null)).toEqual(list(200));
    expect(puts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(puts()).toEqual([{ state: list(200) }]));
    await vi.waitFor(async () => expect(await getLocal(PENDING_KEY, 'unset')).toBeNull());
  });

  it('steady saves never hold the upload back: at most one every 2 s, each the latest', async () => {
    await signIn();
    accountHolds(onAccount(null));
    // A running bot: a card step every 500 ms for 5 s.
    for (let i = 1; i <= 10; i++) {
      await handleBotGallerySet(list(i * 100));
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(puts()).toHaveLength(3));
    expect(puts()).toEqual([{ state: list(400) }, { state: list(800) }, { state: list(1_000) }]);
    await vi.waitFor(async () => expect(await getLocal(PENDING_KEY, 'unset')).toBeNull());
  });

  it('sends one list at a time, so an older one never lands after a newer one', async () => {
    await signIn();
    const answers: Array<() => void> = [];
    // Each PUT waits until the test answers it.
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          if (init?.method !== 'PUT') return resolve(jsonResponse(200, onAccount(null)));
          answers.push(() => resolve(jsonResponse(200, { updatedAt: '2026-10-21T08:00:00.000Z' })));
        }),
    );
    await handleBotGallerySet(list(100));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    // Two more throttled uploads come due while the first is still out.
    await handleBotGallerySet(list(200));
    await vi.advanceTimersByTimeAsync(2_000);
    await handleBotGallerySet(list(300));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(puts()).toEqual([{ state: list(100) }]);
    answers[0]!();
    // The 200 list is not sent: the 300 one is queued behind it.
    await vi.waitFor(() => expect(puts()).toEqual([{ state: list(100) }, { state: list(300) }]));
    answers[1]!();
    await vi.waitFor(async () => expect(await getLocal(PENDING_KEY, 'unset')).toBeNull());
  });

  it('a save made offline goes up at the next load instead of being replaced by the account’s older copy', async () => {
    await signIn();
    await setLocal(BASE_KEY, SAVED_AT);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await handleBotGallerySet(list(300, [90]));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    // Its one retry, after the API client's backoff.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(puts()).toHaveLength(2));
    expect(await getLocal(PENDING_KEY, null)).not.toBeNull();

    // Back online: the account still holds the list from before, which
    // this browser last saw.
    fetchMock.mockReset();
    accountHolds(onAccount(list(100), SAVED_AT));
    expect(await handleBotGalleryGet()).toEqual(list(300, [90]));
    expect(puts()).toEqual([{ state: list(300, [90]) }]);
    expect(await getLocal(PENDING_KEY, 'unset')).toBeNull();
    // The account holds this browser's completed Sets now.
    expect(await getLocal(SYNCED_KEY, null)).toBe(true);
    // Synced now: the next load takes the account's copy again.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(list(700), '2026-10-21T09:00:00.000Z')));
    expect(await handleBotGalleryGet()).toEqual(list(700));
  }, 15_000);

  it('an unsent save loses to a list another browser saved since, but its completed Sets are kept', async () => {
    await signIn();
    // This browser last synced at SAVED_AT, then marked Set 90 completed
    // and closed before the upload went.
    await setLocal(BASE_KEY, SAVED_AT);
    await setLocal(GALLERY_KEY, list(300, [54, 90]));
    await setLocal(PENDING_KEY, 1);
    // Another browser went on with the list since, and completed Set 77.
    accountHolds(onAccount(list(900, [54, 77]), '2026-10-21T07:30:00.000Z'));
    const merged = await handleBotGalleryGet();
    expect(merged).toEqual({ ...list(900, [54, 77]), completed: [54, 77, 90], completedAt: { '54': 54, '77': 77, '90': 90 } });
    expect(await getLocal(GALLERY_KEY, null)).toEqual(merged);
    expect(puts()).toEqual([{ state: merged }]);
    expect(await getLocal(PENDING_KEY, 'unset')).toBeNull();

    // Nothing of this browser's to add: the account's list as it is.
    fetchMock.mockReset();
    await setLocal(BASE_KEY, SAVED_AT);
    await setLocal(PENDING_KEY, 2);
    accountHolds(onAccount(list(1_000, [54, 77, 90]), '2026-10-21T09:30:00.000Z'));
    expect(await handleBotGalleryGet()).toEqual(list(1_000, [54, 77, 90]));
    expect(puts()).toEqual([]);
    expect(await getLocal(PENDING_KEY, 'unset')).toBeNull();
  });
});

describe('background/bot.ts: a browser’s first Gallery sync loses no completed Set', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await clearTokens();
    await setLocal(GALLERY_KEY, null);
    await setLocal(PENDING_KEY, null);
    await setLocal(BASE_KEY, null);
    await setLocal(SYNCED_KEY, null);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await setSession('sl.accessToken', 'access-token');
  });

  afterEach(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const puts = () =>
    fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);
  const accountHolds = (account: GallerySyncResponse, put = () => jsonResponse(200, { updatedAt: '2026-10-21T08:00:00.000Z' })) =>
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'PUT' ? put() : jsonResponse(200, account)));

  it('adds the Sets a second browser completed before sync existed to the account’s list', async () => {
    // Kept before sync existed: no pending mark, never synced.
    await setLocal(GALLERY_KEY, list(300, [90, 54]));
    // The first browser to sync put its own list on the account.
    accountHolds(onAccount(list(900, [54, 77])));
    const merged = { ...list(900, [54, 77]), completed: [54, 77, 90], completedAt: { '54': 54, '77': 77, '90': 90 } };
    expect(await handleBotGalleryGet()).toEqual(merged);
    expect(await getLocal(GALLERY_KEY, null)).toEqual(merged);
    expect(puts()).toEqual([{ state: merged }]);
    expect(await getLocal(SYNCED_KEY, null)).toBe(true);
  });

  it('leaves the first sync to do until the merged list reaches the account', async () => {
    vi.useRealTimers(); // the API client's retry backoff
    await setLocal(GALLERY_KEY, list(300, [90]));
    accountHolds(onAccount(list(900, [54])), () => jsonResponse(500, { code: 'INTERNAL', message: 'Something went wrong.' }));
    const merged = { ...list(900, [54]), completed: [54, 90], completedAt: { '54': 54, '90': 90 } };
    expect(await handleBotGalleryGet()).toEqual(merged);
    expect(await getLocal(SYNCED_KEY, null)).toBeNull();
  }, 15_000);

  it('takes the account’s list as it is when this browser has no Set to add', async () => {
    await setLocal(GALLERY_KEY, list(300, [54]));
    accountHolds(onAccount(list(900, [54, 77])));
    expect(await handleBotGalleryGet()).toEqual(list(900, [54, 77]));
    expect(puts()).toEqual([]);
    expect(await getLocal(SYNCED_KEY, null)).toBe(true);
  });

  it('merges nothing once this browser has synced: a Set undone in another browser stays undone', async () => {
    await setLocal(GALLERY_KEY, list(300, [54, 90]));
    await setLocal(SYNCED_KEY, true);
    // Another browser pressed Undo on Set 90.
    accountHolds(onAccount(list(900, [54])));
    expect(await handleBotGalleryGet()).toEqual(list(900, [54]));
    expect(await getLocal(GALLERY_KEY, null)).toEqual(list(900, [54]));
    expect(puts()).toEqual([]);
  });

  it('leaves the first sync to do when the account cannot be reached', async () => {
    vi.useRealTimers(); // the API client's retry backoff
    await setLocal(GALLERY_KEY, list(300, [90]));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await handleBotGalleryGet()).toEqual(list(300, [90]));
    expect(await getLocal(SYNCED_KEY, null)).toBeNull();
    // Reachable again: the merge happens then.
    fetchMock.mockReset();
    accountHolds(onAccount(list(900, [54])));
    expect((await handleBotGalleryGet())?.completed).toEqual([54, 90]);
    expect(await getLocal(SYNCED_KEY, null)).toBe(true);
  }, 15_000);

  it('uploads this browser’s list to an account with none, and is synced once it lands', async () => {
    await setLocal(GALLERY_KEY, list(300, [90]));
    accountHolds(onAccount(null));
    expect(await handleBotGalleryGet()).toEqual(list(300, [90]));
    await vi.waitFor(() => expect(puts()).toEqual([{ state: list(300, [90]) }]));
    await vi.waitFor(async () => expect(await getLocal(SYNCED_KEY, null)).toBe(true));
  });

  it('keeps the merged completed Sets within their limit, the ones completed longest ago going', async () => {
    const ids = Array.from({ length: GALLERY_LIMITS.completed }, (_, i) => i + 1_000);
    // On the account: the most it holds, each completed at its id.
    const full = list(900, ids);
    await setLocal(GALLERY_KEY, list(300, [90_000]));
    accountHolds(onAccount(full));
    const merged = await handleBotGalleryGet();
    expect(merged!.completed).toHaveLength(GALLERY_LIMITS.completed);
    expect(merged!.completed).not.toContain(1_000);
    expect(merged!.completed!.at(-1)).toBe(90_000);
    expect(Object.keys(merged!.completedAt!)).toHaveLength(GALLERY_LIMITS.completed);
    expect(merged!.completedAt!['1000']).toBeUndefined();
  });
});
