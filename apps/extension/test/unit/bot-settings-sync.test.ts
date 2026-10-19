// The Nova AI bot's settings follow the signed-in account: background keeps
// a local copy and the account's at /api/v1/extension/bot-settings
// (background/bot.ts), so a browser the trader signs in on (another PC, a
// cloud machine) starts with the settings they chose.

import { DEFAULT_BOT_MODE_SETTINGS, DEFAULT_BOT_SETTINGS, type BotSettings, type BotSettingsSyncResponse } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleBotModeGet, handleBotModeSet, handleBotSettingsGet, handleBotSettingsSet } from '../../src/background/bot.js';
import { clearTokens } from '../../src/lib/auth.js';
import { getLocal, setLocal, setSession } from '../../src/lib/storage.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

const SETTINGS_KEY = 'sl.bot.settings.v1';
const PENDING_KEY = 'sl.bot.settings.pending.v1';

const withDelay = (min: number, max: number): BotSettings => ({ ...DEFAULT_BOT_SETTINGS, searchDelay: { min, max } });
const onAccount = (settings: BotSettings | null): BotSettingsSyncResponse => ({
  settings,
  updatedAt: settings ? '2026-10-18T07:00:00.000Z' : null,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('background/bot.ts: bot settings follow the account', () => {
  useRealChromeStorage();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await clearTokens();
    await setLocal(SETTINGS_KEY, null);
    await setLocal(PENDING_KEY, null);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const signIn = () => setSession('sl.accessToken', 'access-token');
  /** The PUT bodies sent so far. */
  const puts = () =>
    fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);

  it('uses this browser’s settings while signed out, and sends nothing', async () => {
    await setLocal(SETTINGS_KEY, withDelay(1.5, 2));
    expect(await handleBotSettingsGet()).toEqual(withDelay(1.5, 2));
    await handleBotSettingsSet(withDelay(3, 4));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await getLocal(SETTINGS_KEY, null)).toEqual(withDelay(3, 4));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts a new browser with the account’s settings, and keeps them as its local copy', async () => {
    await signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(withDelay(1.5, 2))));
    expect(await handleBotSettingsGet()).toEqual(withDelay(1.5, 2));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test.local/api/v1/extension/bot-settings');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-token');
    expect(await getLocal(SETTINGS_KEY, null)).toEqual(withDelay(1.5, 2));
  });

  it('the account wins over an older local copy', async () => {
    await signIn();
    await setLocal(SETTINGS_KEY, withDelay(5, 6));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(withDelay(1.5, 2))));
    expect(await handleBotSettingsGet()).toEqual(withDelay(1.5, 2));
    expect(puts()).toEqual([]);
  });

  it('uploads this browser’s settings when the account has none yet', async () => {
    await signIn();
    await setLocal(SETTINGS_KEY, withDelay(5, 6));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(null)));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(withDelay(5, 6))));
    expect(await handleBotSettingsGet()).toEqual(withDelay(5, 6));
    await vi.waitFor(() => expect(puts()).toEqual([{ settings: withDelay(5, 6) }]));
  });

  it('gives the defaults to a new browser on an account that never saved any', async () => {
    await signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(null)));
    expect(await handleBotSettingsGet()).toEqual(DEFAULT_BOT_SETTINGS);
    expect(puts()).toEqual([]);
  });

  it('falls back to the local copy when the account cannot be reached or refuses, and never overwrites it then', async () => {
    vi.useRealTimers(); // the API client's retry backoff
    await signIn();
    await setLocal(SETTINGS_KEY, withDelay(5, 6));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await handleBotSettingsGet()).toEqual(withDelay(5, 6));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(500, { code: 'INTERNAL', message: 'Something went wrong.' }));
    expect(await handleBotSettingsGet()).toEqual(withDelay(5, 6));
    // Not "the account has none": the account may well hold newer settings.
    expect(puts()).toEqual([]);
  }, 15_000);

  it('saves here at once and to the account shortly after, one upload for a burst of edits', async () => {
    await signIn();
    fetchMock.mockResolvedValue(jsonResponse(200, onAccount(withDelay(3, 4))));
    await handleBotSettingsSet(withDelay(2, 3));
    await vi.advanceTimersByTimeAsync(500);
    await handleBotSettingsSet(withDelay(3, 4));
    expect(await getLocal(SETTINGS_KEY, null)).toEqual(withDelay(3, 4));
    expect(puts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(puts()).toEqual([{ settings: withDelay(3, 4) }]));
    await vi.waitFor(async () => expect(await getLocal(PENDING_KEY, 'unset')).toBeNull());
  });

  it('a save made offline goes up at the next load instead of being replaced by the account’s older copy', async () => {
    await signIn();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await handleBotSettingsSet(withDelay(3, 4));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    expect(await getLocal(PENDING_KEY, null)).not.toBeNull();

    // Back online: the account still holds the settings from before.
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? jsonResponse(200, onAccount(withDelay(3, 4))) : jsonResponse(200, onAccount(withDelay(9, 10))),
    );
    expect(await handleBotSettingsGet()).toEqual(withDelay(3, 4));
    expect(puts()).toEqual([{ settings: withDelay(3, 4) }]);
    expect(await getLocal(PENDING_KEY, 'unset')).toBeNull();
    // Synced now: the next load takes the account's copy again.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, onAccount(withDelay(7, 8))));
    expect(await handleBotSettingsGet()).toEqual(withDelay(7, 8));
  }, 15_000);
});

// Snipe or Bid, and Bid mode's settings, stay in this browser: the API
// validates the account's bot settings strictly, so they cannot ride along
// until it carries them (`botModeSettingsSchema`).
describe('background/bot.ts: Snipe or Bid stays in this browser', () => {
  useRealChromeStorage();
  const MODE_KEY = 'sl.bot.mode.v1';

  beforeEach(async () => {
    await clearTokens();
    await setLocal(MODE_KEY, null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts on Snipe, keeps what is saved, and sends nothing to the account', async () => {
    expect(await handleBotModeGet()).toEqual(DEFAULT_BOT_MODE_SETTINGS);
    await setSession('sl.accessToken', 'access-token');
    const bid = { mode: 'bid' as const, bidding: { windowMinutes: 3, maxActiveBids: 8, maxBidsPerHour: 40 } };
    await handleBotModeSet(bid);
    expect(await handleBotModeGet()).toEqual(bid);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reads a stored value that no longer parses as the defaults (Snipe)', async () => {
    await setLocal(MODE_KEY, { mode: 'bid', bidding: { maxActiveBids: 500 } });
    expect(await handleBotModeGet()).toEqual(DEFAULT_BOT_MODE_SETTINGS);
  });
});
