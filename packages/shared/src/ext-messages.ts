import { z } from 'zod';

import { ADAPTER_CHANNEL, isEaAssetUrl } from './adapter-channel.js';
import { activityEventSchema } from './schemas/activity.js';
import { emailSchema, passwordSchema } from './schemas/auth.js';
import { botDailyUsageSchema, botSettingsSchema } from './schemas/bot.js';
import { filterCriteriaSchema, filterStatsSchema, savedFilterSchema } from './schemas/filters.js';
import { coinPriceSchema, MAX_COIN_PRICE } from './schemas/ingest-bounds.js';
import { riskBudgetEventSchema } from './schemas/risk.js';
import { snipingAttemptSchema } from './schemas/sniping.js';
import { tradeIngestSchema } from './schemas/trades.js';

import type { AutomationBackgroundMessageType } from './automation-messages.js';

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
export { ADAPTER_CHANNEL, EA_ASSET_DOMAINS, isEaAssetUrl } from './adapter-channel.js';

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
  /** Whether the adapter could buy this listing if asked: false when the
   * EA service-layer shape it selected buys on an item entity it has not
   * seen for this listing, or when it selected no shape at all
   * (apps/extension/src/main/adapter.ts). Absent means unknown (older
   * records); the ranker only drops an explicit `false`. */
  buyable: z.boolean().optional(),
  /** EA's id for the card itself (`itemData.id`), which, unlike the
   * tradeId, survives a purchase and every relist. The trade lifecycle
   * (apps/extension/src/lib/trade-lifecycle.ts) keys on it to link a buy to
   * its later sale. Absent when the listing did not carry one. */
  itemId: z.string().min(1).max(40).optional(),
  /** The card's name as EA's item data carries it (an assumption until the
   * market opens: docs/06-extension.md §4), for the panel and the assist
   * confirm overlay. Absent when the item carried none. */
  name: z.string().min(1).max(80).optional(),
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
    /** `false` when the adapter never received this page load's act-channel
     * nonce, so it can authenticate no act request. Unsigned, so only a
     * hint: content reports a call that then times out as
     * `adapter_unauthenticated` (not retried), and never fails a call on
     * this flag alone. */
    actReady: z.boolean().optional(),
    /** Which candidate EA service-layer shape the probe selected
     * (`main/adapter.ts`, docs/06-extension.md §4). Absent when `ok` is
     * false: no shape, no act. */
    shape: z.enum(['promise', 'observable']).optional(),
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

/** Listings already reported in an `auctions` message that the adapter can
 * now buy (the observable shape saw their item entities through its search
 * hook, main/search-hook.ts). Not a search: content marks the tracked
 * listings buyable and counts or records nothing. Unsigned, like
 * `auctions`: a forged one can at worst make content try a listing the
 * adapter then refuses with a signed `listing_entity_unknown`. */
export const adapterListingsBuyableMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('listings_buyable'),
  data: z.object({ tradeIds: z.array(z.string().min(1).max(40)).max(500) }),
});

/** An image URL in the catalog: https on an EA host only
 * (`isEaAssetUrl`). The catalog is built in the page's MAIN world from
 * page globals, so anything else is refused, never shown. */
const eaAssetUrlSchema = z
  .string()
  .max(600)
  .refine(isEaAssetUrl, { message: 'must be an https URL on an EA host' });

const catalogOptionSchema = z
  .object({
    id: z.number().int(),
    value: z.string().max(40),
    label: z.string().min(1).max(120),
    img: eaAssetUrlSchema.optional(),
    levels: z.boolean().optional(),
  })
  .strict();

/** The Sniping Bot's Snipe Targets choices, as the EA web app's own search
 * panel lists them (apps/extension `model/catalog.ts`): built in the page
 * by the adapter (automation builds only), sent to content in a signed
 * `catalog` message, and stored by background (`catalog.save`). Strict and
 * bounded everywhere: it crosses the page's `window.postMessage`. */
export const adapterCatalogSchema = z
  .object({
    players: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            name: z.string().min(1).max(80),
            rating: z.number().int().min(0).max(99).nullable(),
          })
          .strict(),
      )
      .max(100_000),
    portrait: eaAssetUrlSchema.optional(),
    levels: z.array(catalogOptionSchema).max(20),
    rarities: z.array(catalogOptionSchema).max(1_000),
    positions: z.array(catalogOptionSchema).max(50),
    playStyles: z.array(catalogOptionSchema).max(100),
    nations: z.array(catalogOptionSchema).max(1_000),
    leagues: z.array(catalogOptionSchema).max(1_000),
    clubs: z.record(z.string().regex(/^\d+$/), z.array(catalogOptionSchema).max(500)),
    capturedAt: z.number().int(),
    notes: z.array(z.string().max(500)).max(50).optional(),
  })
  .strict();
/** One item on the trader's own trade pile (or watch list, or a
 * relist/status response), as main/ea-listing.ts's `normalisePileItem`
 * reads it. Every EA path and field behind it is an assumption
 * (docs/06-extension.md, day-one checklist). `tradeState` is EA's word
 * for the listing: `active` (listed), `closed` (sold), `expired`, or null
 * (on the pile, not listed). Prices are what EA reports: for a `closed`
 * listing, `currentBid` is the sale price. */
export const TRADE_PILE_STATES = ['active', 'closed', 'expired'] as const;
export const tradePileItemSchema = z.object({
  itemId: z.string().min(1).max(40),
  tradeId: z.string().max(40).nullable(),
  resourceId: z.number().int().positive(),
  rating: z.number().int().min(0).max(99).nullable(),
  tradeState: z.enum(TRADE_PILE_STATES).nullable(),
  // Bounded like every price the API takes: an out-of-range one would
  // otherwise reach /trades/batch and 400 the whole chunk the sale is in.
  currentBid: coinPriceSchema,
  buyNowPrice: coinPriceSchema,
  /** Seconds left on the listing when read, or null if unknown. */
  expires: z.number().nullable(),
});
export type TradePileItem = z.infer<typeof tradePileItemSchema>;

/** The trader's own items, read passively from an EA trade-pile response
 * (main/adapter.ts). Not a search: content counts nothing for it, and
 * forwards the items to background's trade lifecycle. Unsigned, like
 * `auctions`: a forged one could at worst report a sale the server then
 * records for a trade the extension itself bought (the lifecycle ignores
 * any item it has no buy for). */
export const adapterTradePileMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('tradepile'),
  data: z.object({
    url: z.string().max(500),
    seenAt: z.number(),
    items: z.array(tradePileItemSchema).max(500),
    /** A plain GET of `/tradepile`: plausibly the whole transfer list, so
     * a followed item missing from it has left the pile (sold while not
     * watched, quick-sold or moved to the club). */
    full: z.boolean().optional(),
  }),
});

/** HMAC-SHA256 (hex) of an act-channel message under the per-page-load
 * nonce (apps/extension/src/lib/act-auth.ts). Optional in these schemas so
 * the shapes stay additive, but both ends of the extension require it: the
 * adapter ignores an `act_request` without a valid one, and content drops
 * an `action_result` without one — any page script can post on this
 * channel, and the MAC is what tells the extension's own messages apart. */
export const adapterMessageMacSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A description of an object by key names and value types only — never
 * values (`main/diagnostics.ts`'s `describeKeys`). A leaf is a type name
 * (`'function'`, `'number'`, `'object'` past the depth limit, ...). */
export type DiagnosticsKeyTree = string | { [key: string]: DiagnosticsKeyTree };
export const diagnosticsKeyTreeSchema: z.ZodType<DiagnosticsKeyTree> = z.lazy(() =>
  z.union([z.string().max(200), z.record(z.string().max(200), diagnosticsKeyTreeSchema)]),
);

/** What the adapter knows about the page's EA service layer, for the
 * options page's "Copy diagnostics" (docs/06-extension.md §4, day-one
 * checklist). Read-only, and carries no values from the page: key names,
 * types, the adapter's own counters and its own (scrubbed) log lines.
 * Every field is spelled out, not `.passthrough()`: content verifies the
 * MAC over the *parsed* result, so a key zod stripped would fail it. */
export const adapterDiagnosticsSchema = z.object({
  probe: z.object({
    ok: z.boolean(),
    reason: z.string().max(2000).optional(),
    shape: z.enum(['promise', 'observable']).nullable(),
    checkedAt: z.number(),
  }),
  /** Every candidate shape the probe tried, in order, and why it was not
   * present — the first thing to read when `probe.ok` is false. */
  candidates: z
    .array(
      z.object({
        shape: z.string().max(40),
        present: z.boolean(),
        reason: z.string().max(500).optional(),
      }),
    )
    .max(10),
  /** `window.services`, key names down to depth 3. */
  servicesKeys: diagnosticsKeyTreeSchema,
  /** Types of the few page globals a shape relies on (e.g. the search
   * criteria constructor). */
  globals: z.record(z.string().max(80), z.string().max(40)),
  /** The last market response the adapter saw (passive or act search),
   * keys and types only. */
  lastMarketResponse: z
    .object({ source: z.string().max(40), at: z.number(), shape: diagnosticsKeyTreeSchema })
    .nullable(),
  /** The last trade-pile response (tradepile, watchlist, relist, trade
   * status) the adapter saw, keys and types only: the trade-pile paths
   * and fields are unverified assumptions (docs/06-extension.md). */
  lastTradePileResponse: z
    .object({ path: z.string().max(200), at: z.number(), shape: diagnosticsKeyTreeSchema })
    .nullable()
    .optional(),
  stats: z.object({ seen: z.number(), parsed: z.number(), failed: z.number() }),
  /** The adapter's last 50 log lines, already scrubbed. */
  log: z.array(z.string().max(1000)).max(50),
});
export type AdapterDiagnostics = z.infer<typeof adapterDiagnosticsSchema>;

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
    action: z.enum(['search', 'buy', 'readResult', 'diagnostics']),
    requestId: z.string().min(1).optional(),
    ok: z.boolean(),
    requestedAt: z.number(),
    completedAt: z.number(),
    error: z.string().optional(),
    /** Only present for `action: 'readResult'` — a coarse "is this trade
     * still an open listing" read, never listing contents beyond what
     * `trimAuction` already allows out of the page. */
    stillListed: z.boolean().optional(),
    /** Only present for `action: 'diagnostics'`. */
    diagnostics: adapterDiagnosticsSchema.optional(),
    /** A second result for a `buy` whose first result was
     * `error: 'timeout_unknown'`: EA's answer arrived after the adapter
     * stopped waiting, and `ok` says whether it bought. */
    late: z.boolean().optional(),
  }),
  mac: adapterMessageMacSchema.optional(),
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
    z.object({
      action: z.literal('search'),
      requestId: z.string().min(1),
      filter: filterCriteriaSchema,
    }),
    z.object({
      action: z.literal('buy'),
      requestId: z.string().min(1),
      tradeId: z.string().min(1),
      /** The buy-now price content expects to pay. The adapter refuses
       * (`price_mismatch` / `listing_unknown`) unless it equals the price
       * it last saw listed for `tradeId`; a listing with no buy-now price
       * (0) never matches. `main/adapter.ts`'s zod-free `asActRequest`
       * re-checks this shape by hand — keep the two in sync. */
      price: z.number().int().positive(),
      /** The card content means to buy. When present the adapter also
       * refuses (`resource_mismatch`) unless the listing it saw for
       * `tradeId` is this card — the `auctions` messages content matched
       * the filter against are unsigned, so they could claim any tradeId
       * is the target card. */
      resourceId: z.number().int().positive().optional(),
      /** Likewise the card's base player id (a filter can target a player
       * by it): when present it must match the listing's too. */
      assetId: z.number().int().positive().optional(),
    }),
    z.object({
      action: z.literal('readResult'),
      requestId: z.string().min(1),
      tradeId: z.string().min(1),
    }),
    /** Read-only: the adapter's diagnostics report (options page, "Copy
     * diagnostics"). Authenticated like every other act request, so no page
     * script can make the adapter describe the page to it on demand. */
    z.object({
      action: z.literal('diagnostics'),
      requestId: z.string().min(1),
    }),
    /** Automation builds: (re-)send the Sniping Bot's catalog if the
     * adapter has one (it may have been built before the content script was
     * listening). Authenticated like every other act request; the adapter
     * answers with a signed `catalog` message, not an `action_result`. */
    z.object({
      action: z.literal('catalog'),
      requestId: z.string().min(1),
    }),
  ]),
  mac: adapterMessageMacSchema.optional(),
});
export type AdapterActRequestMessage = z.infer<typeof adapterActRequestMessageSchema>;

/** Automation builds: the Sniping Bot's catalog, adapter -> content, in
 * reply to a `catalog` act request or when the adapter has built a newer
 * one. Signed like `action_result` (the MAC covers `kind` and `data`), and
 * the MAC is required: content drops a catalog without a valid one, so no
 * page script can choose what the bot's target form offers. */
export const adapterCatalogMessageSchema = z.object({
  channel: z.literal(ADAPTER_CHANNEL),
  kind: z.literal('catalog'),
  data: z.object({ catalog: adapterCatalogSchema }).strict(),
  mac: adapterMessageMacSchema,
});
export type AdapterCatalogMessage = z.infer<typeof adapterCatalogMessageSchema>;

export const adapterMessageSchema = z.discriminatedUnion('kind', [
  adapterReadyMessageSchema,
  adapterProbeMessageSchema,
  adapterShapeMessageSchema,
  adapterAuctionsMessageSchema,
  adapterListingsBuyableMessageSchema,
  adapterTradePileMessageSchema,
  adapterActionResultMessageSchema,
  adapterCatalogMessageSchema,
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
  /** The live engine state (`idle`/`running`/`paused`/`halted`) of the EA
   * tab that holds the engine lease, pushed on every lease renewal, so the
   * 10-minute heartbeat alarm reports the real one instead of `idle`. */
  'engine.state',
  /** The per-profile engine lease (P0 Task 13): only the EA tab holding it
   * runs an engine (assist hotkeys, autobuyer, Sniping Bot), so two tabs can
   * never spend the same hourly budgets twice. Kept by background in
   * `storage.session`, renewed by the holder, released on `pagehide`. */
  'engine.lockAcquire',
  'engine.lockRelease',
  /** The popup's "New session" button: background passes it to the EA tabs
   * (`extContentResetSessionMessageSchema`), whose governor starts a new
   * session (`Governor.resetSession`). */
  'engine.resetSession',
  /** Added additively (docs/12-testing.md "Defects found" row #10): the
   * content script's crash-recovery state (`Governor.serialize()`) used to
   * be written straight to `browser.storage.session` from the content
   * script — which Chrome forbids for content scripts (MV3's default
   * `storage.session` access level is `TRUSTED_CONTEXTS` only), so the
   * read threw, the content script's boot aborted, and every later market
   * observation crashed on an uninitialised binding. The state now round-
   * trips through background (`engine.stateGet` / `engine.stateSet`), the
   * same way the live risk snapshot does — the access level is deliberately
   * *not* widened, because `storage.session` also holds the access token. */
  'engine.stateGet',
  'engine.stateSet',
  /** Added additively: the content script's cheap, no-network read of the
   * server kill switch from background's cached entitlement (`storage.local`)
   * on every engine tick — the pull half of kill-switch propagation; the
   * push half is the `engine.killSwitch` tab message below. */
  'license.killSwitchGet',
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
  /** The trade lifecycle (apps/extension/src/lib/trade-lifecycle.ts, run
   * in background so every tab shares one record per item): a buy the
   * engine made, the trade-pile items content saw, and the session P&L the
   * panel and popup show. */
  'lifecycle.buy',
  'lifecycle.pile',
  'lifecycle.sessionPnl',
  'lifecycle.stats',
  /** Realised profit since local midnight: the popup's daily profit goal
   * progress (`targets.dailyProfitGoal`). */
  'lifecycle.todayPnl',
]);
/** Every message type background handles in every build: the core types
 * above plus the automation builds' own (`AUTOMATION_BACKGROUND_MESSAGE_TYPES`,
 * kept in their own module so the listable build never carries them). */
export type BackgroundMessageType =
  z.infer<typeof backgroundMessageTypeSchema> | AutomationBackgroundMessageType;

/** Generic envelope every `chrome.runtime.sendMessage` call uses; `payload`
 * is typed per `BackgroundMessageType` by the sender/handler, not by this
 * shared shape, since the content/background split (unlike the adapter
 * channel) is internal to the extension and does not need a discriminated
 * union validated at the boundary. This one accepts the core types only;
 * background builds its own from its handler table
 * (`backgroundMessageEnvelopeSchemaFor`), so the automation types are
 * accepted exactly where their handlers are registered. */
export const backgroundMessageEnvelopeSchema = z.object({
  type: backgroundMessageTypeSchema,
  payload: z.unknown().optional(),
});
export type BackgroundMessageEnvelope = z.infer<typeof backgroundMessageEnvelopeSchema>;

/** The envelope for exactly `types`: apps/extension `background/index.ts`
 * passes its handler table's keys, so the envelope can never drift from
 * what is registered (and a `__proto__`-style key is never a type). */
export function backgroundMessageEnvelopeSchemaFor(types: readonly string[]) {
  const allowed = new Set(types);
  return z.object({
    type: z
      .string()
      .min(1)
      .max(64)
      .refine((t) => allowed.has(t), { message: 'unknown message type' }),
    payload: z.unknown().optional(),
  });
}

export const backgroundResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  /** `code` is the API's error code when the failure came from `apps/api`
   * (`AUTH_INVALID_CREDENTIALS`, `RATE_LIMITED`...), so a UI can explain it. */
  z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
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
// `counts`) has nothing here to validate and isn't listed —
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

/** `lifecycle.buy` — a card the engine just bought, keyed by the item it
 * bought (not the listing), with the purchase exactly as reported to
 * `/trades/batch`, so the later sale report updates that same trade. */
export const extBackgroundLifecycleBuyPayloadSchema = z
  .object({
    /** Null when the bought listing carried no item id: the buy cannot be
     * followed, and is only counted (diagnostics). */
    itemId: z.string().min(1).max(40).nullable(),
    tradeId: z.string().min(1).max(64),
    resourceId: z.number().int().positive(),
    rating: z.number().int().min(0).max(99).nullable(),
    buyPrice: z.number().int().min(1).max(MAX_COIN_PRICE),
    boughtAt: z.string().datetime(),
  })
  .strict();
export type LifecycleBuy = z.infer<typeof extBackgroundLifecycleBuyPayloadSchema>;

/** `lifecycle.pile` — trade-pile items the adapter read. */
export const extBackgroundLifecyclePilePayloadSchema = z
  .object({ items: z.array(tradePileItemSchema).max(500), full: z.boolean().optional() })
  .strict();

/** `lifecycle.stats` reply, for the diagnostics report: buys that carried
 * no item id (since background last started), items being followed, and
 * sales reported (kept 30 days). */
export interface LifecycleStats {
  buysWithoutItemId: number;
  followed: number;
  salesReported: number;
}

/** `lifecycle.sessionPnl` reply. `realised` is net of EA's tax
 * (`computeTradeProfit`); `unrealised` is what the items still listed are
 * listed at. A display figure only: the server recomputes every stored
 * trade's profit itself. */
export interface LifecycleSessionPnl {
  realised: number;
  unrealised: number;
  sales: number;
  listed: number;
  since: number;
}

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
export const extBackgroundBotSettingsSetPayloadSchema = botSettingsSchema;
export const extBackgroundBotUsageSetPayloadSchema = botDailyUsageSchema;

/** `catalog.save`: the Snipe Targets form's choices, as the EA web app's own
 * search panel lists them (apps/extension `model/catalog.ts`). The same
 * shape the adapter sends content in a signed `catalog` message. */
export const extBackgroundCatalogSavePayloadSchema = adapterCatalogSchema;

export const extBackgroundCardNamesPayloadSchema = z
  .object({
    resourceIds: z.array(z.number().int().positive()).max(50),
  })
  .strict();

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
  z.object({ kind: z.literal('trades'), items: z.array(tradeIngestSchema).max(500) }).strict(),
  z.object({ kind: z.literal('filterStats'), items: z.array(filterStatsSchema).max(200) }).strict(),
  z
    .object({ kind: z.literal('riskEvents'), items: z.array(riskBudgetEventSchema).max(200) })
    .strict(),
  z
    .object({ kind: z.literal('event'), items: z.array(extTelemetryPlainEventSchema).max(500) })
    .strict(),
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
    // The session budget meter (P0 Task 13): coins spent this session, and
    // the user's `budgets.sessionCoinBudget` (null = no cap). Optional, so a
    // tab still running an older build keeps pushing.
    sessionCoinsSpent: z.number().min(0).optional(),
    sessionCoinBudget: z.number().min(0).nullable().optional(),
  })
  .strict();
export type ExtGovernorSnapshotPushPayload = z.infer<
  typeof extBackgroundGovernorSnapshotPushPayloadSchema
>;

/** `engine.stateSet` — `engine/governor.ts`'s `Governor.serialize()` output
 * (its `GovernorState`), persisted by background in `storage.session` for
 * crash recovery (docs/06-extension.md §7) and read back with
 * `engine.stateGet` (no payload; replies with this shape or `null`). Mirrors
 * that interface field-for-field; `.strict()` per the mass-assignment rule
 * (docs/09-security.md "Extension"). */
/** Background -> content (`browser.tabs.sendMessage` to every open EA tab,
 * `background/kill-switch.ts`): the server kill switch changed, or a
 * heartbeat re-confirmed it active. Project rule 3 makes the kill switch
 * unconditional, so it cannot wait for the next page load — this message
 * is how an already-running engine learns about it. Validated by
 * `content/index.ts` before it touches the governor. */
export const extContentKillSwitchMessageSchema = z
  .object({
    type: z.literal('engine.killSwitch'),
    payload: z
      .object({
        active: z.boolean(),
        reason: z.string().max(500).optional(),
      })
      .strict(),
  })
  .strict();
export type ExtContentKillSwitchMessage = z.infer<typeof extContentKillSwitchMessageSchema>;

/** Options page -> an EA tab's content script: collect the adapter's
 * diagnostics report (`content/diagnostics.ts`). Answered with
 * `extContentDiagnosticsResponseSchema`. */
export const extContentDiagnosticsRequestSchema = z
  .object({ type: z.literal('diagnostics.collect') })
  .strict();
export const extContentDiagnosticsResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), diagnostics: adapterDiagnosticsSchema }),
  z.object({ ok: z.literal(false), error: z.string().max(2000) }),
]);
export type ExtContentDiagnosticsResponse = z.infer<typeof extContentDiagnosticsResponseSchema>;

export const extBackgroundEngineStateSetPayloadSchema = z
  .object({
    sessionStartedAt: z.number().min(0),
    actionTimestamps: z.array(z.number().min(0)).max(10_000),
    searchCount: z.number().int().min(0),
    buyCount: z.number().int().min(0),
    coinFlow: z.array(z.object({ at: z.number().min(0), coins: z.number() }).strict()).max(10_000),
    cooldownUntil: z.number().min(0),
    // Optional: state persisted by a build without the session-reset flag
    // still validates (engine/governor.ts's `GovernorState`).
    sessionExpired: z.boolean().optional(),
    // Optional for the same reason: coins spent this session.
    sessionCoinsSpent: z.number().min(0).optional(),
    killSwitchActive: z.boolean(),
    killSwitchReason: z.string().max(500).optional(),
  })
  .strict();
export type ExtEngineStateSetPayload = z.infer<typeof extBackgroundEngineStateSetPayloadSchema>;

/** `bot.budgetSet` (automation builds): the Sniping Bot's hourly budgets —
 * its own governor's state (`Governor.serialize()`) and its sliding
 * one-hour search and buy windows (apps/extension `engine/sniper.ts`).
 * Kept in `storage.local` and hydrated on every start, so Stop/Start and a
 * page reload never refill them. Bounded by `BOT_LIMITS`' hourly maxima. */
export const extBackgroundBotBudgetSetPayloadSchema = z
  .object({
    governor: extBackgroundEngineStateSetPayloadSchema,
    searchTimes: z.array(z.number().min(0)).max(10_000),
    buyTimes: z.array(z.number().min(0)).max(10_000),
  })
  .strict();
export type BotBudgetState = z.infer<typeof extBackgroundBotBudgetSetPayloadSchema>;

// ---- the assist loop (P0 Task 13) --------------------------------------------

/** `engine.lockAcquire` / `engine.lockRelease`: the content script's own id
 * (a random UUID per page load). Acquire answers `{ held, expiresAt }`. */
export const extBackgroundEngineLockPayloadSchema = z
  .object({
    ownerId: z.string().uuid(),
  })
  .strict();
export type ExtEngineLockPayload = z.infer<typeof extBackgroundEngineLockPayloadSchema>;

export const ENGINE_STATES = ['idle', 'running', 'paused', 'halted'] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

/** `engine.state`: what the lease holder's engine is doing, for the
 * heartbeat's `engineState` (`heartbeatRequestSchema`). */
export const extBackgroundEngineStatePayloadSchema = z
  .object({
    engineState: z.enum(ENGINE_STATES),
  })
  .strict();

/** Background -> EA tab: the popup's "New session". No payload. */
export const extContentResetSessionMessageSchema = z
  .object({
    type: z.literal('engine.resetSession'),
  })
  .strict();

/**
 * One assist hotkey: a modifier chord written as modifiers then a
 * `KeyboardEvent.code`, e.g. `Alt+KeyB` or `Ctrl+Alt+ArrowUp`. It must hold
 * Alt, Ctrl or Meta, so no assist hotkey is ever a key EA's own UI uses on
 * its own (Enter, Space, the arrows) or one that types a character (Shift
 * alone). The code, not the key: Alt+B types `∫` on a Mac keyboard, and
 * `KeyB` is the same physical key on every layout.
 */
export const HOTKEY_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const hotkeyChordSchema = z
  .string()
  .max(40)
  .regex(/^(?:(?:Ctrl|Alt|Shift|Meta)\+){1,4}[A-Za-z][A-Za-z0-9]{0,19}$/, 'not a key chord')
  .refine(
    (chord) => {
      const mods = chord.split('+').slice(0, -1);
      return new Set(mods).size === mods.length && mods.some((m) => m !== 'Shift');
    },
    { message: 'a hotkey needs Alt, Ctrl or Meta, each modifier once' },
  );

export const assistHotkeysSchema = z
  .object({
    /** Buy the selected listing (a second press, or a click, confirms). */
    buy: hotkeyChordSchema,
    /** Move the selection through the current search's listings. */
    selectUp: hotkeyChordSchema,
    selectDown: hotkeyChordSchema,
    /** Cycle the saved filters (an engine-issued, governed search). */
    nextFilter: hotkeyChordSchema,
    prevFilter: hotkeyChordSchema,
    /** Pause or resume the assist hotkeys. */
    togglePause: hotkeyChordSchema,
  })
  .strict()
  .refine((keys) => new Set(Object.values(keys)).size === Object.keys(keys).length, {
    message: 'each hotkey must be a different chord',
  });
export type AssistHotkeys = z.infer<typeof assistHotkeysSchema>;

/** The assist hotkeys the extension ships with, fixed for now (no settings
 * surface edits them): Alt+B buys, Alt+Up/Down move the selection. */
export const DEFAULT_ASSIST_HOTKEYS: AssistHotkeys = {
  buy: 'Alt+KeyB',
  selectUp: 'Alt+ArrowUp',
  selectDown: 'Alt+ArrowDown',
  nextFilter: 'Alt+KeyN',
  prevFilter: 'Alt+Shift+KeyN',
  togglePause: 'Alt+KeyP',
};
