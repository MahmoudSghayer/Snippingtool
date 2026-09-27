// Background's side of the assist loop (P0 Task 13): "New session" passed on to the EA tabs, today's P&L for the daily
// goal, and the heartbeat reporting the engine state the lease holder
// pushed instead of always `idle`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleEngineResetSession, handleEngineState } from '../../src/background/engine-lease.js';
import { handleLifecycleTodayPnl } from '../../src/background/lifecycle.js';
import * as license from '../../src/lib/license.js';
import { setLocal } from '../../src/lib/storage.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

describe('New session (engine.resetSession)', () => {
  useRealChromeStorage();

  it('is passed on to every open EA tab, and to nothing else', async () => {
    const chromeTabs = (globalThis as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs;
    const query = vi.fn((_q: unknown, cb: (t: { id: number }[]) => void) => cb([{ id: 5 }, { id: 6 }]));
    const sent: Array<{ tabId: number; message: unknown }> = [];
    chromeTabs.query = query;
    chromeTabs.sendMessage = vi.fn((tabId: number, message: unknown, optionsOrCb?: unknown, cb?: (r: unknown) => void) => {
      sent.push({ tabId, message });
      (typeof optionsOrCb === 'function' ? (optionsOrCb as (r: unknown) => void) : cb)?.(undefined);
    });
    expect(await handleEngineResetSession()).toEqual({ notified: 2 });
    expect((query.mock.calls[0]![0] as { url: string[] }).url).toEqual(
      expect.arrayContaining(['https://www.ea.com/*/ultimate-team/web-app/*']),
    );
    expect(sent).toEqual([
      { tabId: 5, message: { type: 'engine.resetSession' } },
      { tabId: 6, message: { type: 'engine.resetSession' } },
    ]);
  });
});

describe('today’s P&L (the popup’s daily goal)', () => {
  it('counts from local midnight', async () => {
    const pnl = await handleLifecycleTodayPnl();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(pnl.since).toBe(midnight.getTime());
  });
});

describe('the heartbeat reports the real engine state', () => {
  useRealChromeStorage();
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await setLocal('sl.deviceId', '11111111-1111-4111-8111-111111111111');
  });

  it('sends what the lease holder last pushed, and idle with none', async () => {
    const heartbeat = vi.spyOn(license, 'heartbeat').mockResolvedValue(null);
    const { onHeartbeatAlarm } = await import('../../src/background/license.js');
    await onHeartbeatAlarm();
    expect(heartbeat).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111', 'idle');
    await handleEngineState({ engineState: 'running' });
    await onHeartbeatAlarm();
    expect(heartbeat).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111', 'running');
  });
});
