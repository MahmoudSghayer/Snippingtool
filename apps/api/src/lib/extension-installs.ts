// `extension_installs` bookkeeping: one row per installed copy of the
// extension or the Tampermonkey userscript, read by the admin Overview's
// "Extension versions" donut, the System page's version chart and the
// extension-usage analytics (lib/analytics/kpi.ts, lib/analytics/
// extension.ts).
//
// The install id is the device id the API assigned at bootstrap
// (lib/devices.ts `findOrRegisterDevice`). It is what the client already
// sends on every heartbeat, it is stable across the client's restarts and
// updates (the fingerprint behind it is a per-install salted hash, see
// apps/extension/src/lib/fingerprint.ts), and it is never shared between
// accounts. So an upgrade rewrites the same row's `version` rather than
// leaving the old version behind. A browser update can change the
// fingerprint and so register a new device: the old row then simply stops
// being seen, and `liveExtensionInstallsWhere` drops it after
// `LIVE_INSTALL_WINDOW_DAYS`.

import { extensionInstalls, type Database } from '@sl/db';
import { and, gte, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';

import { newId } from './ids.js';

/** How often an unchanged install's `last_seen` is rewritten. The extension
 * heartbeats every 10 minutes and bootstraps on every page load, so without
 * this every page load would be a write. */
export const INSTALL_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** An install counts as live while it has reported in within this many
 * days (and was not marked uninstalled). */
export const LIVE_INSTALL_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InstallReport {
  /** The reporting device's id (see the file comment). */
  installId: string;
  userId: string;
  version: string;
  /** From the device fingerprint; left as it was when unknown. */
  browser?: string | null;
  now?: Date;
}

/**
 * Upserts the install's row. A new install is inserted; a known one is
 * rewritten only when something changed (version, browser, owner, an
 * `uninstalled_at` to clear) or its `last_seen` is older than
 * `INSTALL_TOUCH_INTERVAL_MS`, so a burst of bootstraps costs one indexed
 * lookup each and no write.
 */
export async function recordExtensionInstall(db: Database, report: InstallReport): Promise<void> {
  const now = report.now ?? new Date();
  const browser = report.browser ?? null;
  const staleBefore = new Date(now.getTime() - INSTALL_TOUCH_INTERVAL_MS);

  await db
    .insert(extensionInstalls)
    .values({
      id: newId(),
      installId: report.installId,
      userId: report.userId,
      version: report.version,
      browser,
      firstSeen: now,
      lastSeen: now,
    })
    .onConflictDoUpdate({
      target: extensionInstalls.installId,
      set: {
        userId: report.userId,
        version: report.version,
        lastSeen: now,
        uninstalledAt: null,
        ...(browser ? { browser } : {}),
      },
      setWhere: or(
        ne(extensionInstalls.version, report.version),
        lt(extensionInstalls.lastSeen, staleBefore),
        isNotNull(extensionInstalls.uninstalledAt),
        isNull(extensionInstalls.userId),
        ne(extensionInstalls.userId, report.userId),
        ...(browser
          ? [isNull(extensionInstalls.browser), ne(extensionInstalls.browser, browser)]
          : []),
      ),
    });
}

/** The `extension_installs` rows that count as live at `now`: not marked
 * uninstalled, and seen within the last `LIVE_INSTALL_WINDOW_DAYS`. */
export function liveExtensionInstallsWhere(now: Date = new Date()) {
  return and(
    isNull(extensionInstalls.uninstalledAt),
    gte(extensionInstalls.lastSeen, new Date(now.getTime() - LIVE_INSTALL_WINDOW_DAYS * DAY_MS)),
  );
}
