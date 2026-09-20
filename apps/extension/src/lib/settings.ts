/*
 * settings.ts — the user's settings document (targets/budgets/governor/
 * telemetryOptOut/notifications, `@sl/shared`'s `userSettingsSchema`).
 *
 * Conflict rule (docs/06-extension.md, "settings sync conflict rules"):
 * **server version wins**. `version` is bumped by `apps/api` on every write;
 * a local edit is only ever a PATCH sent to the server, never applied
 * locally first — the local cache in `storage.local` is a read-through
 * cache plus an offline fallback, not a second source of truth. If the
 * cached `version` is behind what the server returns on the next read (e.g.
 * an admin lowered a governor bound), the cache is simply overwritten;
 * there is no merge, because a lower admin-set ceiling must always win over
 * a stale local value.
 */
import {
  DEFAULT_GOVERNOR_SETTINGS,
  DEFAULT_NOTIFICATION_PREFS,
  type UpdateUserSettingsRequest,
  type UserSettings,
  userSettingsSchema,
} from '@sl/shared';

import { apiJson } from './api.js';
import { logger } from './logger.js';
import { getLocal, setLocal } from './storage.js';

const CACHE_KEY = 'sl.settings.cache.v1';

export const DEFAULT_SETTINGS: UserSettings = {
  version: 0,
  targets: { minProfitPerSnipe: 1000, dailyProfitGoal: null },
  budgets: { maxCoinsPerSnipe: 200_000, sessionCoinBudget: null },
  governor: DEFAULT_GOVERNOR_SETTINGS,
  telemetryOptOut: false,
  notifications: DEFAULT_NOTIFICATION_PREFS,
};

export async function getCachedSettings(): Promise<UserSettings> {
  return getLocal<UserSettings>(CACHE_KEY, DEFAULT_SETTINGS);
}

async function setCachedSettings(settings: UserSettings): Promise<void> {
  await setLocal(CACHE_KEY, settings);
}

/** Bootstrap/heartbeat already carry the settings document — this is the
 * one path that writes the cache from a server response, so every code path
 * (login, startup, heartbeat, explicit refresh) converges on it. */
export async function applyServerSettings(settings: UserSettings): Promise<UserSettings> {
  const parsed = userSettingsSchema.parse(settings);
  await setCachedSettings(parsed);
  return parsed;
}

export async function refreshSettings(): Promise<UserSettings> {
  try {
    const data = await apiJson<UserSettings>('/api/v1/settings');
    return applyServerSettings(data);
  } catch (err) {
    logger.warn(`settings refresh failed, using cache: ${String(err)}`, 'settings');
    return getCachedSettings();
  }
}

/** PATCH — sends the partial update to the server and caches whatever the
 * server hands back (the merged, version-bumped document), never the
 * locally-optimistic merge. */
export async function updateSettings(patch: UpdateUserSettingsRequest): Promise<UserSettings> {
  const data = await apiJson<UserSettings>('/api/v1/settings', { method: 'PATCH', body: JSON.stringify(patch) });
  return applyServerSettings(data);
}
