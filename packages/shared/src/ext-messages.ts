import { z } from 'zod';

import { filterCriteriaSchema } from './schemas/filters.js';

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
export const ADAPTER_CHANNEL = 'ledger:v2';

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
  'auth.logout',
  'auth.refresh',
  'auth.status',
  'license.bootstrap',
  'license.heartbeat',
  'settings.get',
  'settings.set',
  'telemetry.flush',
  'errors.report',
  'engine.state',
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
