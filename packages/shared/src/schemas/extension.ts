import { z } from 'zod';

import { FEATURE_KEYS } from '../constants/plans.js';

import { deviceFingerprintSchema } from './auth.js';
import { ingestTimestampSchema } from './ingest-bounds.js';
import { userSettingsSchema } from './settings.js';
import { licenseDtoSchema, subscriptionDtoSchema } from './subscriptions.js';

/** `POST /extension/bootstrap` — called once on startup (and after login).
 * Returns everything the background service worker needs to decide "am I
 * allowed to run" without another round trip: entitlements, feature flags,
 * and the user's settings document. */
export const bootstrapRequestSchema = z
  .object({
    device: deviceFingerprintSchema,
    extensionVersion: z.string().min(1).max(30),
    buildTarget: z.enum(['ledger', 'ledger-auto', 'userscript']),
  })
  .strict();
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const bootstrapResponseSchema = z.object({
  userId: z.string().uuid(),
  /** The signed-in user's own account email, so the extension can show who
   * it is signed in as. Bootstrap only (omitted from heartbeat below); the
   * API never logs it. */
  email: z.string().email(),
  deviceId: z.string().uuid(),
  subscription: subscriptionDtoSchema.nullable(),
  license: licenseDtoSchema.nullable(),
  features: z.array(z.enum(FEATURE_KEYS)),
  settings: userSettingsSchema,
  killSwitchActive: z.boolean(),
  /** Signed blob (compact EdDSA JWS, claims `entitlementBlobClaimsSchema`)
   * the extension caches for the 24h offline grace window. Verified on every
   * cache read; a cached entitlement's features, kill switch and expiry are
   * read from its claims only. */
  entitlementBlob: z.string().min(1),
  serverTime: z.string().datetime(),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

// `entitlementBlobClaimsSchema` lives in ./entitlement.js (re-exported
// here): the extension's background imports it at runtime, and anything it
// pulls from this module brings this module's other top-level schemas with
// it, including `z.enum(FEATURE_KEYS)` and so the `automation.autobuyer`
// string the listable `ledger` build must never contain.
export { entitlementBlobClaimsSchema, type EntitlementBlobClaims } from './entitlement.js';

/** `POST /extension/heartbeat` — every 10 minutes via an MV3 `alarms` tick
 * (never a `setInterval` in the service worker). Cheap refresh of the same
 * shape bootstrap returns, plus lets the server push a kill switch. */
export const heartbeatRequestSchema = z
  .object({
    deviceId: z.string().uuid(),
    extensionVersion: z.string().min(1).max(30),
    engineState: z.enum(['idle', 'running', 'paused', 'halted']),
  })
  .strict();
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

// Heartbeat omits `email` explicitly: `.omit()` only drops the keys it names,
// so without it every heartbeat would have to carry (and look up) the email.
export const heartbeatResponseSchema = bootstrapResponseSchema.omit({ userId: true, email: true });
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

/** `POST /extension/telemetry` — batched, opt-out respected client-side
 * (the extension simply stops sending if `telemetryOptOut` is set — this
 * endpoint is never the enforcement point, `activity`/`sniping`/`trades`
 * ingest is). Covers version/health telemetry only. */
export const telemetryEventSchema = z
  .object({
    name: z.string().min(1).max(80),
    // Stored in the month-partitioned `user_activity` (ingest-bounds.ts).
    occurredAt: ingestTimestampSchema,
    data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

export const telemetryFlushRequestSchema = z
  .object({
    deviceId: z.string().uuid(),
    events: z.array(telemetryEventSchema).min(1).max(500),
  })
  .strict();
export type TelemetryFlushRequest = z.infer<typeof telemetryFlushRequestSchema>;

/** `POST /extension/errors` — the ring-buffer flush from `lib/errors.ts`. */
export const extensionErrorReportSchema = z
  .object({
    deviceId: z.string().uuid(),
    extensionVersion: z.string().min(1).max(30),
    errors: z
      .array(
        z
          .object({
            message: z.string().min(1).max(2000),
            stack: z.string().max(8000).optional(),
            context: z.string().min(1).max(120).optional(),
            occurredAt: ingestTimestampSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type ExtensionErrorReport = z.infer<typeof extensionErrorReportSchema>;
