// Shared user_settings read/create-default helper — used by modules/settings
// (the canonical get/put surface) and modules/extension (bootstrap/heartbeat
// need the same settings document without a second round trip).

import { userSettings, type Database } from '@sl/db';
import {
  DEFAULT_GOVERNOR_SETTINGS,
  DEFAULT_NOTIFICATION_PREFS,
  type UserSettings,
} from '@sl/shared';
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

export async function getOrCreateUserSettings(
  db: Database,
  userId: string,
): Promise<{ id: string; settings: UserSettings; version: number }> {
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (existing) {
    return {
      id: existing.id,
      settings: existing.settings as UserSettings,
      version: existing.version,
    };
  }
  // `userSettings.userId` is unique (packages/db/src/schema/settings.ts) —
  // two concurrent first-ever calls for the same user (e.g. the extension's
  // bootstrap and a popup PUT landing at the same instant) can both see no
  // `existing` row and both attempt this insert. `onConflictDoNothing` plus
  // a re-select makes the loser fall back to whatever the winner actually
  // created, instead of surfacing that race as a raw unique-violation 500
  // (same defect class as #1 in docs/12-testing.md "Defects found", just
  // one step earlier in this same handler's read-then-write).
  const id = newId();
  const [inserted] = await db
    .insert(userSettings)
    .values({ id, userId, settings: DEFAULT_SETTINGS, version: 1 })
    .onConflictDoNothing({ target: userSettings.userId })
    .returning();
  if (inserted) {
    return {
      id: inserted.id,
      settings: inserted.settings as UserSettings,
      version: inserted.version,
    };
  }
  const raceWinner = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!raceWinner)
    throw new Error(
      `user_settings row for ${userId} missing after onConflictDoNothing insert lost the race`,
    );
  return {
    id: raceWinner.id,
    settings: raceWinner.settings as UserSettings,
    version: raceWinner.version,
  };
}
