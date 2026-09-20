/*
 * background/settings.ts — handlers for `settings.get`/`settings.set` and
 * the (locally-persisted, pending real `/api/v1/filters` — see
 * `packages/shared/src/ext-messages.ts`) `filters.list`/`filters.save`.
 */
import {
  type DeviceDto,
  type SavedFilter,
  type UpdateUserSettingsRequest,
  type UserSettings,
} from '@sl/shared';

import { apiJson } from '../lib/api.js';
import { isAuthenticated } from '../lib/auth.js';
import { exportLogs, type LogEntry } from '../lib/logger.js';
import { getCachedSettings, refreshSettings, updateSettings } from '../lib/settings.js';
import { getLocal, setLocal } from '../lib/storage.js';

const FILTERS_KEY = 'sl.filters.v1';

export async function handleSettingsGet(): Promise<UserSettings> {
  if (await isAuthenticated()) {
    return refreshSettings();
  }
  return getCachedSettings();
}

export async function handleSettingsSet(patch: UpdateUserSettingsRequest): Promise<UserSettings> {
  if (!(await isAuthenticated())) {
    throw new Error('cannot update settings while signed out');
  }
  return updateSettings(patch);
}

export async function handleFiltersList(): Promise<SavedFilter[]> {
  return getLocal<SavedFilter[]>(FILTERS_KEY, []);
}

export async function handleFiltersSave(filters: SavedFilter[]): Promise<SavedFilter[]> {
  await setLocal(FILTERS_KEY, filters);
  return filters;
}

export async function handleDevicesList(): Promise<DeviceDto[]> {
  if (!(await isAuthenticated())) return [];
  try {
    return await apiJson<DeviceDto[]>('/api/v1/devices');
  } catch {
    return []; // apps/api's devices module may not be reachable yet — an empty list, not a crash
  }
}

export function handleLogsExport(): LogEntry[] {
  return exportLogs();
}
