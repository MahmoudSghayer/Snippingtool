// Regression coverage for kill-switch propagation (docs/06-extension.md §5,
// project rule 3 "the server kill switch is unconditional"): before
// `background/kill-switch.ts` existed the content script only read
// `killSwitchActive` from its own bootstrap reply at page load, so an engine
// already running in an open EA tab kept going until the next reload — the
// heartbeat refreshed background's cached entitlement and nobody told the
// tab. These tests pin the push (every open EA tab gets an
// `engine.killSwitch` message when the switch turns on, a deactivation is
// broadcast exactly once, unrelated tabs are never messaged) and the pull
// (`license.killSwitchGet` reflects the cached entitlement, no network).
//
// `chrome.tabs.query`/`sendMessage` are replaced per test with
// callback-convention fakes — that is what webextension-polyfill wraps
// underneath its promise API (see test/setup.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleKillSwitchGet, propagateKillSwitch } from '../../src/background/kill-switch.js';
import { bootstrap } from '../../src/lib/license.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

import type { BootstrapResponse } from '@sl/shared';

type Tab = { id?: number; url: string };

const EA_TAB_A: Tab = { id: 11, url: 'https://www.ea.com/en/ultimate-team/web-app/index.html' };
const EA_TAB_B: Tab = { id: 12, url: 'https://www.ea.com/ultimate-team/web-app/' };

function installTabs(tabs: Tab[]) {
  const chromeTabs = (globalThis as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs;
  const query = vi.fn((_q: unknown, cb: (t: Tab[]) => void) => cb(tabs));
  const sent: Array<{ tabId: number; message: unknown }> = [];
  const sendMessage = vi.fn((tabId: number, message: unknown, optionsOrCb?: unknown, cb?: (r: unknown) => void) => {
    sent.push({ tabId, message });
    const done = typeof optionsOrCb === 'function' ? (optionsOrCb as (r: unknown) => void) : cb;
    done?.(undefined);
  });
  chromeTabs.query = query;
  chromeTabs.sendMessage = sendMessage;
  return { query, sendMessage, sent };
}

function fakeBootstrapResponse(overrides: Partial<BootstrapResponse> = {}): BootstrapResponse {
  return {
    userId: 'user-1',
    subscription: { plan: 'pro', status: 'active', deviceLimit: 2, trialEndsAt: null, currentPeriodEnd: null },
    license: { key: null, maxDevices: 2, expiresAt: null },
    deviceId: '11111111-1111-4111-8111-111111111111',
    features: ['assist.ranker'],
    killSwitchActive: false,
    settings: {
      version: 1,
      targets: { minProfitPerSnipe: 1000, dailyProfitGoal: null },
      budgets: { maxCoinsPerSnipe: 200_000, sessionCoinBudget: null },
      governor: { actionsPerHour: 30, sessionLengthMinutes: 90, buyToSearchRatio: 0.35, cooldownSeconds: 20, maxCoinFlowPerHour: 300_000 },
      telemetryOptOut: false,
      notifications: { email: true, push: false, killSwitch: true, subscriptionChanges: true, weeklyDigest: false },
    },
    entitlementBlob: 'unverifiable-in-tests',
    serverTime: new Date().toISOString(),
    ...overrides,
  } as BootstrapResponse;
}

describe('background/kill-switch.ts: push into open EA tabs', () => {
  useRealChromeStorage();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an activation is pushed to every open EA tab as an engine.killSwitch message with a reason', async () => {
    const { query, sent } = installTabs([EA_TAB_A, EA_TAB_B]);

    const result = await propagateKillSwitch(true, 'admin flipped it');

    expect(result).toEqual({ notified: 2 });
    // The query is url-filtered to the EA web-app patterns — never a
    // blanket "every tab" enumeration.
    const queryArg = query.mock.calls[0]?.[0] as unknown as { url: string[] };
    expect(queryArg.url).toEqual(expect.arrayContaining(['https://www.ea.com/*/ultimate-team/web-app/*']));
    expect(sent.map((s) => s.tabId).sort()).toEqual([11, 12]);
    for (const { message } of sent) {
      expect(message).toEqual({ type: 'engine.killSwitch', payload: { active: true, reason: 'admin flipped it' } });
    }
  });

  it('a heartbeat that re-confirms the switch active re-broadcasts (closes the "tab opened between heartbeats" gap)', async () => {
    const first = installTabs([EA_TAB_A]);
    await propagateKillSwitch(true);
    expect(first.sent).toHaveLength(1);

    const second = installTabs([EA_TAB_A, EA_TAB_B]);
    const result = await propagateKillSwitch(true);
    expect(result.notified).toBe(2);
    expect(second.sent).toHaveLength(2);
  });

  it('a deactivation is broadcast exactly once, and a never-active switch is not broadcast at all', async () => {
    const never = installTabs([EA_TAB_A]);
    expect(await propagateKillSwitch(false)).toEqual({ notified: 0 });
    expect(never.sent).toHaveLength(0);

    await propagateKillSwitch(true);
    const off = installTabs([EA_TAB_A]);
    expect(await propagateKillSwitch(false)).toEqual({ notified: 1 });
    expect(off.sent[0]?.message).toEqual({ type: 'engine.killSwitch', payload: { active: false } });

    const again = installTabs([EA_TAB_A]);
    expect(await propagateKillSwitch(false)).toEqual({ notified: 0 });
    expect(again.sent).toHaveLength(0);
  });

  it('a tab that rejects the message (no content script yet) does not fail the broadcast to the others', async () => {
    const chromeTabs = (globalThis as unknown as { chrome: { tabs: Record<string, unknown>; runtime: { lastError?: unknown } } }).chrome;
    chromeTabs.tabs.query = vi.fn((_q: unknown, cb: (t: Tab[]) => void) => cb([EA_TAB_A, EA_TAB_B]));
    chromeTabs.tabs.sendMessage = vi.fn((tabId: number, _m: unknown, optionsOrCb?: unknown, cb?: (r: unknown) => void) => {
      const done = typeof optionsOrCb === 'function' ? (optionsOrCb as (r: unknown) => void) : cb;
      if (tabId === 11) {
        // The polyfill turns a set runtime.lastError into a rejection.
        chromeTabs.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        done?.(undefined);
        chromeTabs.runtime.lastError = undefined;
      } else {
        done?.(undefined);
      }
    });

    const result = await propagateKillSwitch(true);
    expect(result.notified).toBe(1);
  });
});

describe('background/kill-switch.ts: pull from the cached entitlement', () => {
  useRealChromeStorage();

  it('reports inactive with no cached entitlement, and follows the cached flag afterwards', async () => {
    expect(await handleKillSwitchGet()).toEqual({ active: false });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(fakeBootstrapResponse({ killSwitchActive: true })), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    try {
      await bootstrap();
    } finally {
      fetchSpy.mockRestore();
    }
    const pulled = await handleKillSwitchGet();
    expect(pulled.active).toBe(true);
    expect(pulled.reason).toBeTruthy();
  });
});
