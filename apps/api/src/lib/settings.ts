// Shared user_settings read/create-default helper — used by modules/settings
// (the canonical get/put surface) and modules/extension (bootstrap/heartbeat
// need the same settings document without a second round trip).


import { userSettings, type Database } from '@sl/db';
import { DEFAULT_GOVERNOR_SETTINGS, DEFAULT_NOTIFICATION_PREFS, type UserSettings } from '@sl/shared';
import { eq } from 'drizzle-orm';

import { newId } from './ids.js';

export const DEFAULT_SETTINGS: UserSettings = {
  version: 1,
  targets: { minProfitPerSnipe: 500, dailyProfitGoal: null },
  budgets: { maxCoinsPerSnipe: 50_000, sessionCoinBudget: null },
  governor: DEFAULT_GOVERNOR_SETTINGS,
  telemetryOptOut: false,
  notifications: DEFAULT_NOTIFICATION_PREFS,
};

export async function getOrCreateUserSettings(db: Database, userId: string): Promise<{ id: string; settings: UserSettings; version: number }> {
  const existing = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  if (existing) {
    return { id: existing.id, settings: existing.settings as UserSettings, version: existing.version };
  }
  const id = newId();
  await db.insert(userSettings).values({ id, userId, settings: DEFAULT_SETTINGS, version: 1 });
  return { id, settings: DEFAULT_SETTINGS, version: 1 };
}
