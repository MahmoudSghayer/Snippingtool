import { z } from 'zod';

import { ADAPTER_CHANNEL } from './adapter-channel.js';
import { activityEventSchema } from './schemas/activity.js';
import { emailSchema, passwordSchema } from './schemas/auth.js';
import { filterCriteriaSchema, filterStatsSchema, savedFilterSchema } from './schemas/filters.js';
import { riskBudgetEventSchema } from './schemas/risk.js';
import { snipingAttemptSchema } from './schemas/sniping.js';
import { tradeSchema } from './schemas/trades.js';

/**
 * Typed message shapes for the extension's two internal channels. These are
 * the contract the TypeScript rewrite (docs/01-architecture.md, PHASE 6)
 * implements; `packages/shared` owns the types so `main/adapter.ts`,
 * `content/`, and `background/` can never silently drift apart on a message
 * shape.
 */

// ---- MAIN world (adapter) -> ISOLATED world (content), via window.postMessage ----
// Bumped from the milestone-1 'ledger:v1' channel: v2 adds the bundle probe
// and the `act` surface (search/buy/readResult) alongside passive observation.
// Re-exported from `./adapter-channel.js` (zod-free — see that file) so
// every existing `import { ADAPTER_CHANNEL } from '@sl/shared'` keeps working.
export { ADAPTER_CHANNEL };

export const trimmedAuctionSchema = z.object({
  tradeId: z.string(),
  resourceId: z.number(),
  assetId: z.number(),
  rating: z.number(),
  buyNow: z.number(),
  startingBid: z.number(),
  currentBid: z.number(),
  offers: z.number(),
  expiresAt: z.number().nullable(),
  seenAt: z.number(),
});
export type TrimmedAuction = z.infer<typeof trimmedAuctionSchema>;

export const adapterReadyMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('ready'),
  data: z.object({ channel: z.string() }),
});

/** Result of the bundle probe: did the web app's service layer still look
 * like the shape `adapter.ts` expects? A `false` result is a hard stop —
 * the engine must not act, and the panel goes amber. */
export const adapterProbeMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('probe'),
  data: z.object({
    ok: z.boolean(),
    checkedAt: z.number(),
    reason: z.string().optional(),
  }),
});

export const adapterShapeMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('shape'),
  data: z.object({
    seen: z.number(),
    parsed: z.number(),
    failed: z.number(),
    reason: z.string(),
  }),
});

export const adapterAuctionsMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('auctions'),
  data: z.object({
    url: z.string(),
    seenAt: z.number(),
    auctions: z.array(trimmedAuctionSchema),
    stats: z.object({ seen: z.number(), parsed: z.number(), failed: z.number() }),
  }),
});

/** Result of an `act()` call (`search`/`buy`/`readResult`) driven through
 * the web app's own service layer — never a forged request. Only present in
 * builds where M2/M3 act surface is enabled. `requestId` (added
 * additively — optional, so any older reader of this message still parses
 * it) echoes the triggering `adapterActRequestMessage.data.requestId` so the
 * content script can correlate a reply to the call that made it instead of
 * assuming in-order delivery. */
export const adapterActionResultMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('action_result'),
  data: z.object({
    action: z.enum(['search', 'buy', 'readResult']),
    requestId: z.string().min(1).optional(),
    ok: z.boolean(),
    requestedAt: z.number(),
    completedAt: z.number(),
    error: z.string().optional(),
    /** Only present for `action: 'readResult'` — a coarse "is this trade
     * still an open listing" read, never listing contents beyond what
     * `trimAuction` already allows out of the page. */
    stillListed: z.boolean().optional(),
  }),
});

/** ISOLATED world (content/engine) -> MAIN world (adapter): drive the act
 * surface. This is the inbound half of the channel — `content/index.ts` is
 * the only sender, `adapter.ts` is the only listener, and every request re-runs
 * the bundle probe first (docs/01-architecture.md, §3.5) before touching the
 * assumed service layer. Added additively alongside the existing
 * (adapter -> content) message kinds; `adapterMessageSchema` covers
 * everything the adapter itself *emits*, this one covers what it *accepts*. */
export const adapterActRequestMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('act_request'),
  data: z.discriminatedUnion('action', [
    z.object({ action: z.literal('search'), requestId: z.string().min(1), filter: filterCriteriaSchema }),
    z.object({
      action: z.literal('buy'),
      requestId: z.string().min(1),
      tradeId: z.string().min(1),
      price: z.number().int().min(0),
    }),
    z.object({ action: z.literal('readResult'), requestId: z.string().min(1), tradeId: z.string().min(1) }),
  ]),
});
export type AdapterActRequestMessage = z.infer<typeof adapterActRequestMessageSchema>;

export const adapterMessageSchema = z.discriminatedUnion('kind', [
  adapterReadyMessageSchema,
  adapterProbeMessageSchema,
  adapterShapeMessageSchema,
  adapterAuctionsMessageSchema,
  adapterActionResultMessageSchema,
]);
export type AdapterMessage = z.infer<typeof adapterMessageSchema>;

// ---- content script <-> background service worker, via chrome.runtime messaging ----

export const backgroundMessageTypeSchema = z.enum([
  'record',
  'summary',
  'counts',
  'auth.login',
  'auth.register',
  /** Added additively: the login response can come back `mfa_required`
   * (`@sl/shared`'s `loginResponseSchema`), and the popup's login form needs
   * a second round trip to submit the 6-digit/recovery code against
   * `/auth/mfa/verify` — this is that step. */
  'auth.mfa',
  'auth.logout',
  'auth.refresh',
  'auth.status',
  'license.bootstrap',
  'license.heartbeat',
  'settings.get',
  'settings.set',
  'telemetry.flush',
  /** Added additively alongside `telemetry.flush`: the content script's
   * only way to hand background a batch of one telemetry kind (activity /
   * sniping / trades / filterStats / riskEvents / events — see
   * `lib/telemetry.ts`'s `enqueue*` functions) without importing `lib/api.ts`
   * itself (docs/01-architecture.md: only background talks to the network).
   * `telemetry.flush` remains the separate "flush now" trigger the 10-min
   * alarm (and this message) both use. */
  'telemetry.enqueue',
  'errors.report',
  /** Added additively alongside the popup live risk gauge (docs/10-design-
   * system.md §15, docs/12-testing.md "Defects found"): `content/index.ts`
   * pushes its live governor snapshot on every risk-meter UI tick
   * (`governor.snapshotPush`); the popup asks for the latest cached one on
   * open (`governor.snapshotGet`). */
  'governor.snapshotPush',
  'governor.snapshotGet',
  'engine.state',
  /** Locally-persisted saved filters (`SavedFilter[]`, `storage.local`) —
   * server sync against `/api/v1/filters` lands once `apps/api` ships (see
   * docs/06-extension.md); the message shape already matches that DTO so
   * wiring the real endpoint in is additive, not a rewrite. */
  'filters.list',
  'filters.save',
  /** `GET /api/v1/devices` passthrough for the options page's devices list
   * (added additively — `apps/api`'s devices module is built concurrently;
   * this message shape is forward-compatible with it landing). */
  'devices.list',
  /** Exports `lib/logger.ts`'s ring buffer for the options page's "Export
   * logs" button — local only, no network call. */
  'logs.export',
]);
export type BackgroundMessageType = z.infer<typeof backgroundMessageTypeSchema>;

/** Generic envelope every `chrome.runtime.sendMessage` call uses; `payload`
 * is typed per `BackgroundMessageType` by the sender/handler, not by this
 * shared shape, since the content/background split (unlike the adapter
 * channel) is internal to the extension and does not need a discriminated
 * union validated at the boundary. */
export const backgroundMessageEnvelopeSchema = z.object({
  type: backgroundMessageTypeSchema,
  payload: z.unknown().optional(),
});
export type BackgroundMessageEnvelope = z.infer<typeof backgroundMessageEnvelopeSchema>;

export const backgroundResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type BackgroundResponse = z.infer<typeof backgroundResponseSchema>;

// ---------------------------------------------------------------------------
// Per-handler payload schemas for `background/index.ts`'s `payloadSchemas`
// map (docs/09-security.md open finding #3: validation was not exhaustive —
// only `settings.set` had a dedicated schema, every other handler
// type-cast `payload as never`). One entry per message type that actually
// carries a payload; a handler with no payload (`auth.refresh`,
// `auth.status`, `license.bootstrap`, `settings.get`, `filters.list`,
// `devices.list`, `logs.export`, `telemetry.flush`, `errors.report`,
// `engine.state`, `counts`) has nothing here to validate and isn't listed —
// `backgroundMessageEnvelopeSchema.payload` is optional/`unknown` already,
// and every handler ignores its argument in that case.
//
// Reuses the exact matching `@sl/shared` request/DTO schema wherever the
// background handler's payload shape is identical to what the server
// expects (`auth.mfa` -> `mfaVerifyRequestSchema`, `settings.set` ->
// `updateUserSettingsRequestSchema`, `filters.save`/`telemetry.enqueue`'s
// per-kind items -> the matching DTO schemas) — additive, dedicated schemas
// only where the shape genuinely differs (`auth.login`/`auth.register`/
// `auth.logout`/`license.heartbeat`/`record`/`summary`), per the plan's own
// note that several server-side schemas don't match what the background
// script actually sends (e.g. `auth.login` has no `device` field the way
// the server's `loginRequestSchema` does — the fingerprint is computed
// inside `background/auth.ts` itself, not sent by the caller).
// ---------------------------------------------------------------------------

/** `record` — passive-observation batch (`background/index.ts`'s `record`
 * handler -> `store/db.ts`'s `recordSightings`). Reuses the adapter
 * channel's own auction shape, since this is the same trimmed data the
 * adapter posted, just forwarded to the service worker's IndexedDB store. */
export const extBackgroundRecordPayloadSchema = z
  .object({
    auctions: z.array(trimmedAuctionSchema).max(500),
  })
  .strict();

/** `summary` — one resource's floor/median/sell-through/max-snipe card. */
export const extBackgroundSummaryPayloadSchema = z
  .object({
    resourceId: z.number().int().positive(),
    minProfit: z.number().int().min(0).optional(),
  })
  .strict();

/** `auth.login` — no `device` field: `background/auth.ts`'s `buildDevice()`
 * computes the fingerprint itself from inside the handler. */
export const extBackgroundLoginPayloadSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(256),
  })
  .strict();

/** `auth.register` — same device note as `auth.login` above. */
export const extBackgroundRegisterPayloadSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    timezone: z.string().min(1).max(64).optional(),
    referralCode: z.string().min(1).max(40).optional(),
  })
  .strict();

/** `auth.resendVerification` — re-send the verification email (popup's
 * "check your email" state, defect #3 in docs/12-testing.md). */
export const extBackgroundResendVerificationPayloadSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

/** `.optional()` at the top level (not just its one field): `background/
 * auth.ts`'s `handleAuthLogout` defaults its whole argument to `{}`, and the
 * envelope's `payload` itself is optional — a caller that omits it entirely
 * (payload `undefined`) must still validate, not be rejected as malformed. */
export const extBackgroundLogoutPayloadSchema = z
  .object({
    allDevices: z.boolean().optional(),
  })
  .strict()
  .optional();

export const extBackgroundLicenseHeartbeatPayloadSchema = z
  .object({
    engineState: z.enum(['idle', 'running', 'paused', 'halted']),
  })
  .strict();

/** `filters.save` — the *locally-persisted* `SavedFilter[]` (id, filterHash,
 * etc. already computed), not a creation request. */
export const extBackgroundFiltersSavePayloadSchema = z
  .object({
    filters: z.array(savedFilterSchema).max(200),
  })
  .strict();

/** `event` kind — mirrors `schemas/extension.ts`'s `telemetryEventSchema`
 * exactly, duplicated (not imported) deliberately: that module also builds
 * `bootstrapResponseSchema`, which references `FEATURE_KEYS` (a plan
 * feature-gate vocabulary that includes `'automation.autobuyer'`) — this
 * file is imported by the *listable* extension build's background service
 * worker (`apps/extension/src/background/index.ts`), and docs/09-security.md's
 * build check greps `dist/ledger` for the literal string `autobuyer` and
 * must find none. Importing `telemetryEventSchema` at runtime from
 * `schemas/extension.ts` pulled that whole module — including the
 * `'automation.autobuyer'` string constant — into the background bundle
 * (verified empirically: the bundler didn't tree-shake the unused sibling
 * export away). A 4-line duplicate here avoids that entirely; the two are
 * covered by the same cross-package equivalence, not by import identity. */
const extTelemetryPlainEventSchema = z
  .object({
    name: z.string().min(1).max(80),
    occurredAt: z.string().datetime(),
    data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();

/** `telemetry.enqueue` — mirrors `background/telemetry.ts`'s
 * `TelemetryEnqueuePayload` discriminated union exactly (one array-of-items
 * schema per queue kind, each already a `@sl/shared` DTO/event schema —
 * see `extTelemetryPlainEventSchema` above for why the `event` kind's item
 * schema is duplicated rather than imported). */
export const extBackgroundTelemetryEnqueuePayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('activity'), items: z.array(activityEventSchema).max(500) }).strict(),
  z.object({ kind: z.literal('sniping'), items: z.array(snipingAttemptSchema).max(500) }).strict(),
  z.object({ kind: z.literal('trades'), items: z.array(tradeSchema).max(500) }).strict(),
  z.object({ kind: z.literal('filterStats'), items: z.array(filterStatsSchema).max(200) }).strict(),
  z.object({ kind: z.literal('riskEvents'), items: z.array(riskBudgetEventSchema).max(200) }).strict(),
  z.object({ kind: z.literal('event'), items: z.array(extTelemetryPlainEventSchema).max(500) }).strict(),
]);

/** `governor.snapshotPush` — mirrors `engine/governor.ts`'s `RiskSnapshot`
 * exactly (a structural mirror, not an import: `engine/governor.ts` is
 * automation-surface code, and importing anything from it into this
 * package — which the *listable* build's background service worker also
 * imports — would risk pulling automation-only code into that bundle the
 * same way `extTelemetryPlainEventSchema` above works around for
 * telemetry; a 12-line duplicate here is cheaper than auditing the whole
 * `engine/` module graph for tree-shakeability). `content/index.ts`
 * pushes its live governor snapshot on the same tick that updates the
 * in-page panel's meter (defect: docs/12-testing.md "Defects found",
 * docs/10-design-system.md §15 "Known gap" — the popup previously showed
 * no live numbers at all) so `background/governor.ts` can cache the
 * latest one and hand it to the popup on request
 * (`governor.snapshotGet`). */
export const extBackgroundGovernorSnapshotPushPayloadSchema = z
  .object({
    actionsLastHour: z.number().int().min(0),
    actionsPerHourLimit: z.number().min(0),
    sessionElapsedMinutes: z.number().min(0),
    sessionLengthLimitMinutes: z.number().min(0),
    buyToSearchRatio: z.number().min(0),
    buyToSearchRatioLimit: z.number().min(0),
    coinFlowLastHour: z.number().min(0),
    coinFlowLimit: z.number().min(0),
    inCooldown: z.boolean(),
    cooldownRemainingMs: z.number().min(0),
    killSwitchActive: z.boolean(),
  })
  .strict();
export type ExtGovernorSnapshotPushPayload = z.infer<typeof extBackgroundGovernorSnapshotPushPayloadSchema>;
