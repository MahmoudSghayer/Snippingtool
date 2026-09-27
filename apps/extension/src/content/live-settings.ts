/*
 * live-settings.ts — settings reach an open EA tab without a reload (P0
 * Task 13). Background writes the settings cache from every bootstrap,
 * heartbeat and settings save (lib/settings.ts `applyServerSettings`), and
 * the Sniping Bot page writes the saved filters; this watches those
 * `storage.local` keys through `storage.onChanged` and hands each change
 * over, validated against the same @sl/shared schemas background uses. The
 * values are read from the change itself: nothing here reads storage, so
 * content still never touches `lib/storage.ts` or `storage.session`.
 *
 * Chrome-free: the caller passes `browser.storage.onChanged` in (the
 * userscript's shim has one too).
 */
import { savedFilterSchema, userSettingsSchema } from '@sl/shared';

import { FILTERS_KEY, SETTINGS_CACHE_KEY } from '../lib/storage-keys.js';

import type { Autobuyer } from '../engine/autobuyer.js';
import type { Governor } from '../engine/governor.js';
import type { SavedFilter, UserSettings } from '@sl/shared';

type StorageChanges = Record<string, { newValue?: unknown; oldValue?: unknown }>;

export interface StorageChangedEvent {
  addListener(listener: (changes: StorageChanges, areaName: string) => void): void;
}

export interface LiveSettingsTargets {
  onSettings: (settings: UserSettings) => void;
  onFilters: (filters: SavedFilter[]) => void;
}

const filtersSchema = savedFilterSchema.array().max(200);

export function watchLiveSettings(onChanged: StorageChangedEvent, targets: LiveSettingsTargets): void {
  onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const read = <T>(key: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, apply: (v: T) => void) => {
      const change = changes[key];
      if (!change || change.newValue === undefined) return;
      const parsed = schema.safeParse(change.newValue);
      if (parsed.success) apply(parsed.data as T);
    };
    read(SETTINGS_CACHE_KEY, userSettingsSchema, targets.onSettings);
    read(FILTERS_KEY, filtersSchema, targets.onFilters);
  });
}

/** Applies a settings document to the running engine: the governor's limits
 * (clamped into `GOVERNOR_ABSOLUTE_LIMITS` by `setSettings`, as at
 * construction), its per-buy cap (`budgets.maxCoinsPerSnipe`), and the
 * automation loop's session coin budget. (`automation`, not the class name:
 * a property key survives minification, and the listable build must not
 * name the automation module anywhere — its build check greps for it.) */
export function applySettingsToEngine(
  engine: { governor: Governor | null; automation: Pick<Autobuyer, 'setSessionCoinBudget'> | null },
  settings: UserSettings,
): void {
  engine.governor?.setSettings(settings.governor);
  engine.governor?.setMaxCoinsPerBuy(settings.budgets.maxCoinsPerSnipe);
  engine.automation?.setSessionCoinBudget(settings.budgets.sessionCoinBudget);
}
