// Activity analytics: logins, searches, filter changes, snipe
// attempts/successes, errors, distinct active devices and IPs, bucketed by
// day/week/month/lifetime and zero-filled. Sources: `user_activity` (login/
// filter_change/error), `search_activity` (one row per search), and
// `sniping_activity` (one row per snipe attempt outcome — `success` counts
// toward both `snipeAttempts` and `snipeSuccesses`).

import { searchActivity, snipingActivity, userActivity, type Database } from '@sl/db';
import { and, gte, inArray, lt } from 'drizzle-orm';

import { bucketKeyFor, endOfDayUtc, formatDayUtc, listBuckets, parseDayUtc, type Granularity } from './dates.js';

export interface ActivityRangeParams {
  from: string;
  to: string;
  granularity: Granularity;
}

export interface ActivityPoint {
  bucket: string;
  logins: number;
  searches: number;
  filterChanges: number;
  snipeAttempts: number;
  snipeSuccesses: number;
  errors: number;
  activeDevices: number;
  activeIps: number;
}

export async function getActivitySeries(db: Database, params: ActivityRangeParams): Promise<ActivityPoint[]> {
  const start = parseDayUtc(params.from);
  const end = endOfDayUtc(params.to);

  const [uaRows, searchRows, snipeRows] = await Promise.all([
    db.query.userActivity.findMany({
      where: and(gte(userActivity.occurredAt, start), lt(userActivity.occurredAt, end), inArray(userActivity.type, ['login', 'filter_change', 'error'])),
      columns: { type: true, occurredAt: true, deviceId: true, ip: true },
    }),
    db.query.searchActivity.findMany({
      where: and(gte(searchActivity.occurredAt, start), lt(searchActivity.occurredAt, end)),
      columns: { occurredAt: true, deviceId: true },
    }),
    db.query.snipingActivity.findMany({
      where: and(gte(snipingActivity.occurredAt, start), lt(snipingActivity.occurredAt, end)),
      columns: { occurredAt: true, outcome: true, deviceId: true },
    }),
  ]);

  const buckets = listBuckets(params.from, params.to, params.granularity);
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const points: ActivityPoint[] = buckets.map((bucket) => ({
    bucket,
    logins: 0,
    searches: 0,
    filterChanges: 0,
    snipeAttempts: 0,
    snipeSuccesses: 0,
    errors: 0,
    activeDevices: 0,
    activeIps: 0,
  }));
  const devicesByBucket: Array<Set<string>> = buckets.map(() => new Set());
  const ipsByBucket: Array<Set<string>> = buckets.map(() => new Set());

  const bucketOf = (occurredAt: Date): number | undefined => {
    const key = params.granularity === 'lifetime' ? 'lifetime' : bucketKeyFor(formatDayUtc(occurredAt), params.granularity);
    return idx.get(key);
  };

  for (const row of uaRows) {
    const i = bucketOf(row.occurredAt);
    if (i === undefined) continue;
    if (row.type === 'login') points[i]!.logins++;
    else if (row.type === 'filter_change') points[i]!.filterChanges++;
    else if (row.type === 'error') points[i]!.errors++;
    if (row.deviceId) devicesByBucket[i]!.add(row.deviceId);
    if (row.ip) ipsByBucket[i]!.add(String(row.ip));
  }
  for (const row of searchRows) {
    const i = bucketOf(row.occurredAt);
    if (i === undefined) continue;
    points[i]!.searches++;
    if (row.deviceId) devicesByBucket[i]!.add(row.deviceId);
  }
  for (const row of snipeRows) {
    const i = bucketOf(row.occurredAt);
    if (i === undefined) continue;
    points[i]!.snipeAttempts++;
    if (row.outcome === 'success') points[i]!.snipeSuccesses++;
    if (row.deviceId) devicesByBucket[i]!.add(row.deviceId);
  }

  return points.map((p, i) => ({ ...p, activeDevices: devicesByBucket[i]!.size, activeIps: ipsByBucket[i]!.size }));
}
