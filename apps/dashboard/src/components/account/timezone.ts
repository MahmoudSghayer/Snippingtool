// Time zone helpers for the trades section: the list of IANA zones for the
// picker, the browser's own zone, and "today" in a given zone.

import type { UserDto } from '@sl/shared';

/** The browser's IANA zone, e.g. `Europe/London`. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The zone the trades section starts in: the account's once the trader
 * (or an admin) chose one, even `UTC`, else the browser's. `timezone`
 * alone can't say which: every account starts on `UTC`, and only
 * `timezoneSetAt` (users.timezone_set_at) records an explicit choice. */
export function initialTimeZone(
  user: Pick<UserDto, 'timezone' | 'timezoneSetAt'> | null | undefined,
): string {
  return user?.timezoneSetAt && user.timezone ? user.timezone : browserTimeZone();
}

/** Every IANA zone the browser knows, sorted, always including `UTC` and
 * `current` (Chrome's list leaves `UTC` out). */
export function timeZoneOptions(current: string): string[] {
  const zones = new Set(Intl.supportedValuesOf('timeZone'));
  zones.add('UTC');
  zones.add(current);
  return [...zones].sort();
}

/** `YYYY-MM-DD` of `at` in `tz`: the day the API's `from`/`to` mean when
 * given the same `tz`. */
export function todayIn(tz: string, at: Date = new Date()): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** A trade's timestamp in the trader's zone: `20 Sept 2026, 21:00`. */
export function formatInZone(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}
