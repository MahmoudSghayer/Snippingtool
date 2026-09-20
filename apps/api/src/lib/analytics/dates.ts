// Pure date/bucketing helpers for analytics series: parsing day-only ISO
// strings as UTC calendar dates, deriving bucket keys for day/week/month
// granularity (week = Monday of the ISO week, month = first of month), and
// zero-filling a sparse per-day aggregate into a complete, gap-free series
// over [from, to] at the requested granularity.
//
// Timezone handling: `tz` is accepted by every analytics query schema for
// forward compatibility, but all bucket-boundary math here is UTC-only —
// the `profits`/`analytics_daily`/activity tables store calendar days (or
// timestamps bucketed to UTC days by this module) with no per-row
// timezone, so "the day" is always the UTC calendar day. This is a
// documented limitation (see docs/08-analytics.md "Timezone handling"),
// not an oversight: correct per-viewer DST-aware bucketing would require
// re-deriving every stored day from raw timestamptz rows at query time in
// the viewer's zone, which the `profits` daily-rollup table (computed once,
// in UTC, by `profits.rollup`) does not support without a schema change
// outside this agent's ownership.

export type Granularity = 'day' | 'week' | 'month' | 'lifetime';

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseDayUtc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function formatDayUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** End-of-range boundary for an inclusive 'YYYY-MM-DD' day: the instant just
 * after that day's last millisecond (i.e. the start of the next day). Use
 * as an exclusive upper bound (`< endOfDayUtc(to)`) against timestamptz
 * columns. */
export function endOfDayUtc(day: string): Date {
  return new Date(parseDayUtc(day).getTime() + DAY_MS);
}

/** Every calendar day in [from, to], inclusive, as 'YYYY-MM-DD' strings. */
export function listDays(from: string, to: string): string[] {
  const start = parseDayUtc(from).getTime();
  const end = parseDayUtc(to).getTime();
  if (end < start) return [];
  const days: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    days.push(formatDayUtc(new Date(t)));
  }
  return days;
}

/** Monday (UTC) of the ISO week containing `day`. */
export function weekBucketKey(day: string): string {
  const date = parseDayUtc(day);
  const dow = (date.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(date.getTime() - dow * DAY_MS);
  return formatDayUtc(monday);
}

/** First of the UTC month containing `day`. */
export function monthBucketKey(day: string): string {
  const date = parseDayUtc(day);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function bucketKeyFor(day: string, granularity: Granularity): string {
  if (granularity === 'week') return weekBucketKey(day);
  if (granularity === 'month') return monthBucketKey(day);
  if (granularity === 'lifetime') return 'lifetime';
  return day;
}

/** Every bucket key in [from, to] at `granularity`, in order, with no gaps
 * (e.g. every Monday for 'week', every 1st-of-month for 'month') — the
 * *complete* axis a zero-filled series must cover, not just the buckets
 * that happen to contain data. */
export function listBuckets(from: string, to: string, granularity: Granularity): string[] {
  if (granularity === 'lifetime') return ['lifetime'];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const day of listDays(from, to)) {
    const key = bucketKeyFor(day, granularity);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Aggregates a sparse array of per-day rows into zero-filled buckets over
 * the full [from, to] axis at `granularity`. `zero()` returns a fresh zero
 * accumulator; `add(acc, row)` folds one input row in; `dayOf` extracts the
 * row's UTC day string ('YYYY-MM-DD'). Rows whose day falls outside every
 * bucket on the axis (shouldn't happen if the caller's query was already
 * filtered to [from, to], but kept as a defensive no-op) are dropped rather
 * than creating an out-of-axis bucket.
 */
export function aggregateIntoBuckets<TRow, TAcc>(
  rows: TRow[],
  dayOf: (row: TRow) => string,
  from: string,
  to: string,
  granularity: Granularity,
  zero: () => TAcc,
  add: (acc: TAcc, row: TRow) => TAcc,
): Array<{ bucket: string; value: TAcc }> {
  const buckets = listBuckets(from, to, granularity);
  const acc = new Map<string, TAcc>();
  for (const key of buckets) acc.set(key, zero());
  for (const row of rows) {
    const key = granularity === 'lifetime' ? 'lifetime' : bucketKeyFor(dayOf(row), granularity);
    if (!acc.has(key)) continue;
    acc.set(key, add(acc.get(key)!, row));
  }
  return buckets.map((bucket) => ({ bucket, value: acc.get(bucket)! }));
}
