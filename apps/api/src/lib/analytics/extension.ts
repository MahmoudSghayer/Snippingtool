// Extension usage: heartbeat count in range (`user_activity` type
// 'heartbeat', written by /api/v1/extension/heartbeat), plus a snapshot of
// live installs by version and browser from `extension_installs` (written
// by /extension/bootstrap and /heartbeat; "live" = not uninstalled and seen
// within the last LIVE_INSTALL_WINDOW_DAYS, lib/extension-installs.ts).

import { extensionInstalls, userActivity, type Database } from '@sl/db';
import { and, count, eq, gte, lt } from 'drizzle-orm';

import { liveExtensionInstallsWhere } from '../extension-installs.js';

import { endOfDayUtc, parseDayUtc } from './dates.js';

export interface ExtensionUsageParams {
  from: string;
  to: string;
}

export interface ExtensionUsage {
  heartbeats: number;
  activeInstalls: number;
  byVersion: Record<string, number>;
  byBrowser: Record<string, number>;
}

export async function getExtensionUsage(
  db: Database,
  params: ExtensionUsageParams,
  now: Date = new Date(),
): Promise<ExtensionUsage> {
  const [[heartbeatRow], installRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(userActivity)
      .where(
        and(
          eq(userActivity.type, 'heartbeat'),
          gte(userActivity.occurredAt, parseDayUtc(params.from)),
          lt(userActivity.occurredAt, endOfDayUtc(params.to)),
        ),
      ),
    db
      .select({
        version: extensionInstalls.version,
        browser: extensionInstalls.browser,
        n: count(),
      })
      .from(extensionInstalls)
      .where(liveExtensionInstallsWhere(now))
      .groupBy(extensionInstalls.version, extensionInstalls.browser),
  ]);

  const byVersion: Record<string, number> = {};
  const byBrowser: Record<string, number> = {};
  let activeInstalls = 0;
  for (const r of installRows) {
    byVersion[r.version] = (byVersion[r.version] ?? 0) + r.n;
    const browser = r.browser ?? 'unknown';
    byBrowser[browser] = (byBrowser[browser] ?? 0) + r.n;
    activeInstalls += r.n;
  }

  return {
    heartbeats: heartbeatRow?.n ?? 0,
    activeInstalls,
    byVersion,
    byBrowser,
  };
}
