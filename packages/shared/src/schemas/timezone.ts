import { z } from 'zod';

/** Whether `tz` is an IANA time zone name this runtime knows
 * (`Europe/London`, `UTC`). Checked with `Intl` so the dashboard and the API
 * agree on what's valid, and the API never hands Postgres's `AT TIME ZONE`
 * a string it would reject with a 500. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone name, e.g. `Europe/London`. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'Must be an IANA time zone, e.g. Europe/London.' });
