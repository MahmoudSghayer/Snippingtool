// Extension usage: heartbeat count in range (`user_activity` type
// 'heartbeat', written by /api/v1/extension/heartbeat), plus a snapshot of
// live (not-uninstalled) installs by version and browser from
// `extension_installs`.

import { extensionInstalls, userActivity, type Database } from '@sl/db';
import { and, eq, gte, isNull, lt } from 'drizzle-orm';

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

export async function getExtensionUsage(db: Database, params: ExtensionUsageParams): Promise<ExtensionUsage> {
  const [heartbeatRows, installRows] = await Promise.all([
    db.query.userActivity.findMany({
      where: and(eq(userActivity.type, 'heartbeat'), gte(userActivity.occurredAt, parseDayUtc(params.from)), lt(userActivity.occurredAt, endOfDayUtc(params.to))),
      columns: { id: true },
    }),
    db.query.extensionInstalls.findMany({
      where: isNull(extensionInstalls.uninstalledAt),
      columns: { version: true, browser: true },
    }),
  ]);

  const byVersion: Record<string, number> = {};
  const byBrowser: Record<string, number> = {};
  for (const r of installRows) {
    byVersion[r.version] = (byVersion[r.version] ?? 0) + 1;
    const browser = r.browser ?? 'unknown';
    byBrowser[browser] = (byBrowser[browser] ?? 0) + 1;
  }

  return { heartbeats: heartbeatRows.length, activeInstalls: installRows.length, byVersion, byBrowser };
}
