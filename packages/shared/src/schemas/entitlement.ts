import { z } from 'zod';

import { entitlementSnapshotSchema } from './subscriptions.js';

// Its own module, not schemas/extension.ts: the extension's background
// imports this schema at runtime, and that module also holds
// `bootstrapResponseSchema` with its `z.enum(FEATURE_KEYS)`. Importing from
// there bundled the `automation.autobuyer` string into the listable `ledger`
// build (test/e2e/extension.spec.ts forbids it). Re-exported from
// schemas/extension.ts, so existing imports keep working.

/** The claims inside `entitlementBlob`: a compact EdDSA JWS
 * (`base64url(header).base64url(claims).base64url(signature)`) that
 * `apps/api/src/lib/entitlements.ts` signs with `ENTITLEMENT_SIGNING_KEY`.
 * The extension verifies it against the public key baked into its build and
 * then reads features, expiry and the kill switch *only* from these claims
 * whenever it answers from its cache: the response fields cached next to the
 * blob are plain `storage.local` data anyone can edit.
 *
 * `killSwitchActive` is optional only so blobs signed before it became a
 * claim still verify; the extension never reads a missing claim as "off" —
 * it asks `GET /extension/kill-switch` instead, and assumes "on" if it can't. */
export const entitlementBlobClaimsSchema = z.object({
  snapshot: entitlementSnapshotSchema,
  deviceId: z.string().min(1),
  killSwitchActive: z.boolean().optional(),
  /** userId */
  sub: z.string().min(1),
  /** seconds since epoch, as JWT `iat`/`exp` */
  iat: z.number().int(),
  exp: z.number().int(),
});
export type EntitlementBlobClaims = z.infer<typeof entitlementBlobClaimsSchema>;
