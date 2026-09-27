// Settings and features re-apply to an open EA tab without a reload (P0 Task
// 13, item 4): background writes the settings cache on every bootstrap,
// heartbeat and options-page save, and the tab applies what changed from
// `storage.onChanged` — to the running governor too, clamped as ever.
import { DEFAULT_GOVERNOR_SETTINGS, GOVERNOR_ABSOLUTE_LIMITS, type UserSettings } from '@sl/shared';
import { describe, expect, it, vi } from 'vitest';

import { applySettingsToEngine, watchLiveSettings } from '../../src/content/live-settings.js';
import { Autobuyer } from '../../src/engine/autobuyer.js';
import { Governor } from '../../src/engine/governor.js';
import { FILTERS_KEY, SETTINGS_CACHE_KEY } from '../../src/lib/storage-keys.js';

import type { AdapterClient } from '../../src/content/adapter-client.js';

const settings: UserSettings = {
  version: 3,
  targets: { minProfitPerSnipe: 1500, dailyProfitGoal: 50_000 },
  budgets: { maxCoinsPerSnipe: 20_000, sessionCoinBudget: 100_000 },
  governor: { ...DEFAULT_GOVERNOR_SETTINGS, actionsPerHour: 60 },
  telemetryOptOut: false,
  notifications: { email: true, push: false, killSwitch: true, subscriptionChanges: true, weeklyDigest: false },
};

function onChangedStub() {
  let listener: ((changes: Record<string, { newValue?: unknown }>, area: string) => void) | null = null;
  return {
    event: { addListener: (fn: typeof listener) => void (listener = fn) },
    fire: (changes: Record<string, { newValue?: unknown }>, area = 'local') => listener?.(changes, area),
  };
}

describe('watchLiveSettings', () => {
  it('hands a changed settings document or filter list over, validated', () => {
    const { event, fire } = onChangedStub();
    const targets = { onSettings: vi.fn(), onFilters: vi.fn() };
    watchLiveSettings(event, targets);

    fire({ [SETTINGS_CACHE_KEY]: { newValue: settings } });
    expect(targets.onSettings).toHaveBeenCalledWith(settings);

    fire({ [FILTERS_KEY]: { newValue: [] } });
    expect(targets.onFilters).toHaveBeenCalledWith([]);
  });

  it('ignores a value that does not validate, a removed key, other keys and other areas', () => {
    const { event, fire } = onChangedStub();
    const targets = { onSettings: vi.fn(), onFilters: vi.fn() };
    watchLiveSettings(event, targets);
    fire({ [SETTINGS_CACHE_KEY]: { newValue: { ...settings, governor: 'loose' } } });
    fire({ [FILTERS_KEY]: { newValue: [{ id: 'not a filter' }] } });
    fire({ [SETTINGS_CACHE_KEY]: {} });
    fire({ 'sl.somethingElse': { newValue: settings } });
    fire({ [SETTINGS_CACHE_KEY]: { newValue: settings } }, 'session');
    expect(targets.onSettings).not.toHaveBeenCalled();
    expect(targets.onFilters).not.toHaveBeenCalled();
  });
});

describe('applySettingsToEngine', () => {
  const adapter = { onProbe: () => () => undefined, onShape: () => () => undefined } as unknown as AdapterClient;

  it('re-applies the governor limits to the running governor, clamped to the absolute limits', () => {
    const governor = new Governor(DEFAULT_GOVERNOR_SETTINGS);
    applySettingsToEngine({ governor, automation: null }, settings);
    expect(governor.getSettings().actionsPerHour).toBe(60);
    // A document that got past the schema some other way is still clamped.
    applySettingsToEngine({ governor, automation: null }, { ...settings, governor: { ...settings.governor, actionsPerHour: 100_000 } });
    expect(governor.getSettings().actionsPerHour).toBe(GOVERNOR_ABSOLUTE_LIMITS.actionsPerHour.max);
  });

  it('makes the governor refuse a buy above maxCoinsPerSnipe', () => {
    const governor = new Governor(DEFAULT_GOVERNOR_SETTINGS);
    applySettingsToEngine({ governor, automation: null }, { ...settings, governor: { ...settings.governor, buyToSearchRatio: 1 } });
    governor.allow({ kind: 'search' });
    governor.allow({ kind: 'search' });
    expect(governor.allow({ kind: 'buy', coins: 20_001 }).allowed).toBe(false);
    expect(governor.allow({ kind: 'buy', coins: 20_000 }).allowed).toBe(true);
  });

  it('gives a running autobuyer the new session coin budget', async () => {
    const governor = new Governor({ ...DEFAULT_GOVERNOR_SETTINGS, buyToSearchRatio: 1, actionsPerHour: 120, maxCoinFlowPerHour: 5_000_000 });
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 1 }));
    const autobuyer = new Autobuyer({ governor, adapter: { ...adapter, buy } as unknown as AdapterClient, onAttempt: vi.fn(), onTrade: vi.fn(), sessionCoinBudget: null });
    applySettingsToEngine({ governor, automation: autobuyer }, { ...settings, budgets: { maxCoinsPerSnipe: 200_000, sessionCoinBudget: 1_500 } });
    for (let i = 0; i < 5; i++) governor.allow({ kind: 'search' });
    const listing = (tradeId: string) => ({ resourceId: 1, tradeId, price: 1_000, summary: {} as never, ev: 1, netAtMedian: 1, probabilityOfSale: 1 });
    await autobuyer.runCycle([listing('a'), listing('b')]);
    expect(buy).toHaveBeenCalledTimes(1);
  });
});
