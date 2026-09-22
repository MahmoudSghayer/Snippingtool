// IP monitoring (docs/09-security.md "IP monitoring"): a rolling
// per-(ip, user) counter (`ip_activity`), geo/ASN enrichment via the
// pluggable `GeoIpProvider` (lib/geoip.ts), and impossible-travel / new-
// country detection that raises a `flags` row (`kind: 'suspicious_ip'`) for
// admin review. Called from modules/auth's `completeLogin` on every
// successful login — best-effort, never blocks or fails the login itself.

import { ipActivity, type Database } from '@sl/db';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';

import { createFlag } from '../modules/flags/service.js';

import { getGeoIpProvider, type GeoIpProvider } from './geoip.js';
import { newId } from './ids.js';

export type IpActivityRow = typeof ipActivity.$inferSelect;

/** How recently a *different* country must have been seen for a fresh login
 * from yet another country to be treated as "impossible travel" (stronger
 * evidence) rather than merely "a new country" (weaker evidence, still
 * flagged, just at lower severity). No real distance/speed math — this repo
 * has no geo-coordinate database, only country codes (see lib/geoip.ts) — so
 * this is a deliberately coarse proxy: nobody legitimately logs in from two
 * different countries within 3 hours of each other via a residential
 * connection. */
const IMPOSSIBLE_TRAVEL_WINDOW_MS = 3 * 60 * 60 * 1000;

export interface UpsertIpActivityInput {
  ip: string;
  userId: string | null;
  deviceId: string | null;
}

/** Upserts the (ip, userId) counter row: increments `request_count` and
 * bumps `last_seen` for an existing row, or inserts a new one (enriching
 * country/ASN via the configured `GeoIpProvider` only on first sight of this
 * exact ip+user pair — enrichment never needs to run on every request). Not
 * done as a single atomic `INSERT ... ON CONFLICT` with a SQL-side
 * increment deliberately — this repo's house rule (packages/config/eslint-
 * preset.js's `no-restricted-syntax`) forbids interpolating into a `sql`
 * tagged template at all, so counters here follow the same
 * select-then-write pattern `lib/analytics/materialize.ts` already uses.
 * `ip_activity` is a monitoring/analytics signal, not an authorization
 * decision, so the resulting small race window (two concurrent requests
 * both reading the pre-increment count) is an acceptable, non-security-
 * relevant approximation. */
export async function upsertIpActivity(
  db: Database,
  input: UpsertIpActivityInput,
  provider: GeoIpProvider = getGeoIpProvider(),
): Promise<IpActivityRow> {
  const userMatch = input.userId ? eq(ipActivity.userId, input.userId) : isNull(ipActivity.userId);
  const existing = await db.query.ipActivity.findFirst({
    where: and(eq(ipActivity.ip, input.ip), userMatch),
  });

  if (existing) {
    const [updated] = await db
      .update(ipActivity)
      .set({
        lastSeen: new Date(),
        requestCount: existing.requestCount + 1,
        deviceId: input.deviceId ?? existing.deviceId,
      })
      .where(eq(ipActivity.id, existing.id))
      .returning();
    return updated!;
  }

  const enrichment = await provider.lookup(input.ip).catch(() => ({ country: null, asn: null }));

  const [inserted] = await db
    .insert(ipActivity)
    .values({
      id: newId(),
      ip: input.ip,
      userId: input.userId,
      deviceId: input.deviceId,
      country: enrichment.country,
      asn: enrichment.asn,
    })
    .onConflictDoNothing({ target: [ipActivity.ip, ipActivity.userId] })
    .returning();

  if (inserted) return inserted;

  // Lost a race with a concurrent request for the exact same (ip, userId) —
  // the other request's insert won; re-read what it wrote.
  const row = await db.query.ipActivity.findFirst({
    where: and(eq(ipActivity.ip, input.ip), userMatch),
  });
  if (!row) throw new Error('upsertIpActivity: insert raced and re-read found nothing');
  return row;
}

export interface RecordSuspiciousIpInput {
  userId: string;
  ip: string;
  /** The just-upserted row for this login's (ip, userId) — only its
   * `country`/`createdAt` are read; this function itself looks at the
   * user's *other* IP history to decide whether this login's country is
   * new. */
  activity: IpActivityRow;
}

/**
 * New-country / impossible-travel detection. Looks at the user's other
 * `ip_activity` rows (different IP than this login's) and:
 *  - if this login's country was never seen before for this user, and the
 *    user has prior IP history at all (so "first login ever" never flags) →
 *    `flags` row, severity `medium`, evidence `{ reason: 'new_country' }`.
 *  - if, in addition, the most recently seen *different* country was seen
 *    within `IMPOSSIBLE_TRAVEL_WINDOW_MS` → severity escalates to `high`,
 *    evidence `{ reason: 'impossible_travel', minutesSincePrevious }`.
 * Never runs at all if geo enrichment came back `null` (no provider
 * configured, or the lookup failed) — an unknown country can't be compared
 * to anything, so this silently no-ops rather than guessing.
 */
export async function recordSuspiciousIpIfAny(
  db: Database,
  input: RecordSuspiciousIpInput,
): Promise<void> {
  const country = input.activity.country;
  if (!country) return;

  const priorRows = await db.query.ipActivity.findMany({
    where: and(eq(ipActivity.userId, input.userId), ne(ipActivity.ip, input.ip)),
    orderBy: [desc(ipActivity.lastSeen)],
    limit: 20,
  });
  if (priorRows.length === 0) return; // no prior history for this user — nothing to compare against

  const knownCountries = new Set(
    priorRows.map((r) => r.country).filter((c): c is string => Boolean(c)),
  );
  if (knownCountries.size === 0) return; // prior rows exist but none are enriched — nothing to compare against
  if (knownCountries.has(country)) return; // already seen this country from this user — not new

  const mostRecentDifferentCountry = priorRows.find((r) => r.country && r.country !== country);
  const minutesSincePrevious = mostRecentDifferentCountry
    ? Math.round((Date.now() - mostRecentDifferentCountry.lastSeen.getTime()) / 60_000)
    : null;
  const isImpossibleTravel =
    mostRecentDifferentCountry != null &&
    Date.now() - mostRecentDifferentCountry.lastSeen.getTime() < IMPOSSIBLE_TRAVEL_WINDOW_MS;

  await createFlag(db, {
    userId: input.userId,
    kind: 'suspicious_ip',
    severity: isImpossibleTravel ? 'high' : 'medium',
    evidence: {
      reason: isImpossibleTravel ? 'impossible_travel' : 'new_country',
      ip: input.ip,
      newCountry: country,
      previousCountry: mostRecentDifferentCountry?.country ?? null,
      minutesSincePreviousCountry: minutesSincePrevious,
    },
  });

  await db.update(ipActivity).set({ flagged: true }).where(eq(ipActivity.id, input.activity.id));
}
