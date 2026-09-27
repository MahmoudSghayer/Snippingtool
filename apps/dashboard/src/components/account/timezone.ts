// Time zone helpers for the trades section: the list of IANA zones for the
// picker, the browser's own zone, and "today" in a given zone.

/** The browser's IANA zone, e.g. `Europe/London`. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The zone the trades section starts in: the one saved on the account, or
 * the browser's while the account still has the `UTC` it was created with
 * (every account starts on `UTC`, so that is not a choice anyone made). */
export function initialTimeZone(saved: string | null | undefined): string {
  return saved && saved !== 'UTC' ? saved : browserTimeZone();
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
