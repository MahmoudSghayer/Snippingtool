/*
 * adapter.ts — the ONLY file that knows anything about EA's internals.
 *
 * Runs in the page's MAIN world (manifest: world "MAIN", document_start) so
 * it can see the web app's own network calls and, from M2 onward, its own
 * service layer. Two jobs, both governed by the same rule — never issue a
 * request the app's own UI would not have issued, never touch the session
 * token, never forge or replay anything:
 *
 *   1. Passive observation (M1, unchanged from milestone 1): patch
 *      XMLHttpRequest and fetch to *read* responses the app was already
 *      going to receive, trim them with `trimAuction`, and post the result
 *      to the ISOLATED world over `window.postMessage`.
 *   2. The `act` surface (M2/M3): `search`, `buy`, `readResult`, each driven
 *      by calling the web app's OWN service-layer functions — the same
 *      functions its own UI calls when a human clicks Search or Buy Now.
 *      This file never constructs a UTAS request by hand. Present in both
 *      builds (assist's human-confirmed buys use it), and only reachable
 *      with a MAC under the per-page-load nonce (lib/act-auth.ts) — any
 *      script on the page can post on this channel. A buy is also refused
 *      unless its price matches the listing this file last saw.
 *
 * When EA reshuffles their bundle, this is the one file that breaks — and it
 * is written to break LOUDLY. Passive observation reports every market call
 * it sees and every one it successfully parsed (`kind: 'shape'` on a
 * mismatch, unchanged from milestone 1). The act surface additionally runs a
 * *bundle probe* before it will do anything at all — see below.
 */
// `ADAPTER_CHANNEL` comes from the zod-free `adapter-channel.js` subpath, not
// the `@sl/shared` barrel — this file runs in the page's MAIN world on every
// matching load, so it deliberately avoids pulling `zod` and every schema in
// `ext-messages.ts` along with it just for one string constant (see
// packages/shared/src/adapter-channel.ts).
import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';

import { ACT_ERROR, canonicalActMessage, canonicalize, createActSigner, takeHandedOffNonce, type ActSigner } from '../lib/act-auth.js';

import type { FilterCriteria, TrimmedAuction } from '@sl/shared';

// ---- act-channel authentication (docs/09-security.md §13) --------------------
// Taken first thing, at `document_start`, before any page script exists:
// the per-page-load nonce content/handoff.ts left on <html>. Only the HMAC
// key derived from it is kept, inside `signer`'s closure; the attribute is
// removed as it is read. With no nonce, `signer` stays null and every
// act_request is ignored — passive observation keeps working regardless.
let signer: ActSigner | null = null;
takeHandedOffNonce(document, (nonce) => {
  signer = createActSigner(nonce);
});

// Captured at load for the same reason as lib/act-auth.ts's primitives: a
// page script that runs later cannot swap what the adapter reads with. This
// covers the auth path and the data the buy price check relies on (market
// response -> trimAuction -> lastSeenListings), not every line of this file:
// the MAIN world is shared with the page, so this raises the bar, it is not
// a boundary (docs/threat-model.md §3.1).
const apply = Reflect.apply;
const parseJson = JSON.parse;
const stringifyJson = JSON.stringify;
const toNumber = Number;
const toStr = String;
const isFiniteNumber = Number.isFinite;
const isInteger = Number.isInteger;
const now = Date.now;
const URLCtor = URL;
const mapGet = Map.prototype.get;
const mapHas = Map.prototype.has;
const mapSet = Map.prototype.set;
const mapClear = Map.prototype.clear;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const promiseThen = Promise.prototype.then;
function protoGetter(proto: object | undefined, name: string): ((this: unknown) => unknown) | undefined {
  return proto ? (Object.getOwnPropertyDescriptor(proto, name)?.get as ((this: unknown) => unknown) | undefined) : undefined;
}

/* ------------------------------------------------------------------------ *
 * ASSUMED SHAPE — verify on day one
 *
 * The live EA FC web app is unreachable while the market is locked (see
 * docs/06-extension.md, "Day-one verification checklist"), so the act
 * surface below is written against a *documented assumption*, not observed
 * fact. It follows the pattern prior sniping tools in this space have
 * reported for the FC web app's Angular-ish service layer: a global
 * `window.services` registry of singleton repository objects, one per
 * domain, each exposing promise-returning methods that the app's own
 * controllers call.
 *
 * Assumed lookups (every single one is guarded — a missing or
 * wrong-shaped property is a clean `probe()` failure, never a thrown
 * exception):
 *
 *   window.services.Item.repository.search(criteria) -> Promise<{ auctionInfo: RawAuction[] }>
 *     The same call the app's own search form issues. `criteria` is assumed
 *     to accept the FC web app's own filter field names (resourceId,
 *     minBuy/maxBuy, minRating/maxRating, position, nation, leagueId, teamId,
 *     type) — `mapFilterToSearchCriteria` below is the one place that
 *     mapping lives, so it is the second thing to fix after `probe()`
 *     itself if EA renames a field.
 *
 *   window.services.Transfer.repository.buyNow(tradeId) -> Promise<unknown>
 *     The same call the app's own "Buy Now" button issues on an auction row.
 *     Resolution is assumed to mean the app accepted the click; an explicit
 *     `{ success: false }` shape (if EA's app resolves failures instead of
 *     rejecting) is treated as a failure too.
 *
 *   window.services.Transfer.repository.bid(tradeId, amount) -> Promise<unknown>
 *     Not used by M2/assist or M3/autobuyer today (both only ever snipe at
 *     buy-now), but probed for because its absence is itself a strong signal
 *     the Transfer repository has been renamed or restructured — cheap extra
 *     confidence in the probe result for one guarded property read.
 *
 * If EA's real shape differs (near-certain — this is a documented guess, not
 * a verified one), `probe()` fails closed: `ok: false` with a `reason`
 * string identifying exactly which lookup came back wrong, the engine hard-
 * stops before ever calling `act.search`/`act.buy`, and the panel goes
 * amber. Fixing a real mismatch means updating the guarded lookups here (and
 * `mapFilterToSearchCriteria`/`extractAuctionInfo` if the response envelope
 * also changed) — nowhere else in the codebase needs to know EA's shape at
 * all, by design (docs/01-architecture.md, "never-forge-a-request seam").
 * ------------------------------------------------------------------------ */

interface AssumedItemRepository {
  search: (criteria: Record<string, unknown>) => Promise<unknown>;
}

interface AssumedTransferRepository {
  buyNow: (tradeId: string) => Promise<unknown>;
  bid: (tradeId: string, amount: number) => Promise<unknown>;
}

interface AssumedServices {
  Item?: { repository?: Partial<AssumedItemRepository> };
  Transfer?: { repository?: Partial<AssumedTransferRepository> };
}

function assumedServices(): AssumedServices | null {
  const w = window as unknown as { services?: unknown };
  if (!w.services || typeof w.services !== 'object') return null;
  return w.services as AssumedServices;
}

interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/** Verify the assumed service-layer shape still holds. Called once at load
 * and again before every single `act` call (docs/01-architecture.md, §3.5) —
 * never cached across calls, because the whole point is to catch a bundle
 * update mid-session, not just at page load. */
function probe(): ProbeResult {
  const services = assumedServices();
  if (!services) return { ok: false, reason: 'window.services is missing or not an object' };

  const itemSearch = services.Item?.repository?.search;
  if (typeof itemSearch !== 'function') {
    return { ok: false, reason: 'window.services.Item.repository.search is not a function' };
  }

  const buyNow = services.Transfer?.repository?.buyNow;
  if (typeof buyNow !== 'function') {
    return { ok: false, reason: 'window.services.Transfer.repository.buyNow is not a function' };
  }

  const bid = services.Transfer?.repository?.bid;
  if (typeof bid !== 'function') {
    return { ok: false, reason: 'window.services.Transfer.repository.bid is not a function' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------

// The UTAS market path has outlived many bundle rewrites: /ut/game/<title>/transfermarket
const MARKET_PATH = /\/ut\/game\/[^/]+\/transfermarket\b/i;
// ...and it is only a market response if EA served it. Without the host
// check, a page script could fetch a market-shaped path from its own server
// and have the adapter record (and later price-check against) whatever
// listing it made up.
const EA_HOST = /(^|\.)ea\.com$/i;

const stats = { seen: 0, parsed: 0, failed: 0 };

function post(kind: 'ready', data: { channel: string }): void;
function post(kind: 'probe', data: { ok: boolean; checkedAt: number; reason?: string; actReady: boolean }): void;
function post(kind: 'shape', data: { seen: number; parsed: number; failed: number; reason: string }): void;
function post(
  kind: 'auctions',
  data: { url: string; seenAt: number; auctions: TrimmedAuction[]; stats: { seen: number; parsed: number; failed: number } },
): void;
function post(kind: string, data: unknown): void {
  try {
    window.postMessage({ channel: ADAPTER_CHANNEL, kind, data }, window.location.origin);
  } catch {
    /* a page that has torn down its origin is not our problem */
  }
}

interface ActionResult {
  action: 'search' | 'buy' | 'readResult';
  requestId: string;
  ok: boolean;
  requestedAt: number;
  completedAt: number;
  error?: string;
  stillListed?: boolean;
}

/** `action_result` is the one adapter -> content message that carries a MAC
 * (lib/act-auth.ts): content only believes a buy happened if the adapter,
 * not some page script, says so. Only ever sent in reply to an authenticated
 * request, so `signer` is always set here in practice. */
function postResult(data: ActionResult): void {
  const s = signer;
  if (!s) return;
  s.sign(canonicalActMessage('action_result', data)).then(
    (mac) => {
      try {
        window.postMessage({ channel: ADAPTER_CHANNEL, kind: 'action_result', data, mac }, window.location.origin);
      } catch {
        /* a page that has torn down its origin is not our problem */
      }
    },
    () => undefined,
  );
}

function runProbeAndReport(): ProbeResult {
  const result = probe();
  // `actReady: false` means no nonce reached this adapter, so no act request
  // can ever be authenticated; content fails its calls fast on seeing it
  // rather than waiting out the timeout (content/adapter-client.ts).
  post('probe', { ...result, checkedAt: Date.now(), actReady: signer !== null });
  return result;
}

/*
 * Trim an auction down to the fields the model actually uses.
 *
 * This is deliberate, not just tidiness: nothing about the account, the club,
 * the session or the user leaves this function. If a field is not listed
 * here, the extension never sees it. This is the one function every
 * `TrimmedAuction` in the system passes through — the privacy seam named in
 * docs/01-architecture.md's trust-boundary table.
 */
function trimAuction(a: Record<string, unknown>, seenAt: number): TrimmedAuction {
  const item = (a.itemData as Record<string, unknown>) || {};
  const expiresIn = toNumber(a.expires);
  return {
    tradeId: toStr(a.tradeId),
    resourceId: toNumber(item.resourceId ?? item.assetId ?? 0),
    assetId: toNumber(item.assetId ?? 0),
    rating: toNumber(item.rating ?? 0),
    buyNow: toNumber(a.buyNowPrice ?? 0),
    startingBid: toNumber(a.startingBid ?? 0),
    currentBid: toNumber(a.currentBid ?? 0),
    offers: toNumber(a.offers ?? 0),
    // expires arrives as seconds remaining; an absolute time is what we can compare later
    expiresAt: isFiniteNumber(expiresIn) ? seenAt + expiresIn * 1000 : null,
    seenAt,
  };
}

/** Trim + emit a raw `auctionInfo` array through the same 'auctions' message
 * passive observation uses, whether it came from a patched network response
 * or from `act.search()` driving `services.Item.repository.search`
 * directly — one pipeline, one privacy seam, regardless of source. */
function emitAuctionInfo(url: string, auctionInfo: unknown[]): TrimmedAuction[] {
  const seenAt = now();
  const auctions: TrimmedAuction[] = [];
  for (let i = 0; i < auctionInfo.length; i++) {
    const a = auctionInfo[i];
    if (!a || typeof a !== 'object' || (a as Record<string, unknown>).tradeId == null) continue;
    const trimmed = trimAuction(a as Record<string, unknown>, seenAt);
    if (trimmed.resourceId > 0) {
      auctions[auctions.length] = trimmed;
      rememberListing(trimmed);
    }
  }
  stats.parsed++;
  post('auctions', { url, seenAt, auctions, stats: { ...stats } });
  return auctions;
}

/*
 * The buy-now price the adapter itself last saw for each tradeId, from a
 * real EA market response (passive or act search). `actBuy` checks the
 * price content expects against this before calling buyNow — buyNow takes
 * only a tradeId, so without the check a forged cheap listing for an
 * expensive tradeId would buy at the real price (defect C12). There is no
 * single-listing price lookup in the ASSUMED SHAPE's service layer (see
 * probe()), so this is "the latest listing data we saw", not a fresh read.
 *
 * Keyed per tradeId rather than "the latest response only": assist ranks
 * candidates from every response seen in the last few minutes
 * (content/index.ts's `tracked`), and a listing's buy-now price is fixed
 * for its lifetime (a relist gets a new tradeId). Bounded: past the cap it
 * starts over, which at worst turns one buy into a `listing_unknown` refusal
 * until the next search. Read and written only through the captured Map
 * methods.
 */
interface SeenListing {
  buyNow: number;
  expiresAt: number | null;
}
const MAX_REMEMBERED_LISTINGS = 5000;
const lastSeenListings = new Map<string, SeenListing>();
let rememberedListings = 0;

function rememberListing(a: TrimmedAuction): void {
  if (!apply(mapHas, lastSeenListings, [a.tradeId])) {
    if (++rememberedListings > MAX_REMEMBERED_LISTINGS) {
      apply(mapClear, lastSeenListings, []);
      rememberedListings = 1;
    }
  }
  apply(mapSet, lastSeenListings, [a.tradeId, { buyNow: a.buyNow, expiresAt: a.expiresAt }]);
}

function handleBody(url: string, body: unknown): void {
  if (typeof body !== 'string' || body.length === 0) {
    stats.failed++;
    post('shape', { ...stats, reason: 'empty body' });
    return;
  }

  let payload: unknown;
  try {
    payload = parseJson(body);
  } catch {
    stats.failed++;
    post('shape', { ...stats, reason: 'response was not JSON' });
    return;
  }

  const auctionInfo = (payload as Record<string, unknown> | null)?.auctionInfo;
  if (!payload || !Array.isArray(auctionInfo)) {
    // A market call with no auctionInfo is how a payload change first shows up.
    stats.failed++;
    post('shape', { ...stats, reason: 'no auctionInfo array in response' });
    return;
  }

  emitAuctionInfo(String(url).split('?')[0] ?? url, auctionInfo);
}

function isMarket(url: unknown): url is string {
  if (typeof url !== 'string' || url === '') return false;
  try {
    const parsed = new URLCtor(url, window.location.href);
    return parsed.protocol === 'https:' && EA_HOST.test(parsed.hostname) && MARKET_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

// ---- XMLHttpRequest --------------------------------------------------------
const proto = XMLHttpRequest.prototype;
const nativeOpen = proto.open;
const nativeSend = proto.send;
// Read responses through the prototype's own getters, captured now, so an
// own property defined on one XHR instance (or a later prototype patch)
// cannot hand the adapter a body EA never sent.
const xhrResponseURL = protoGetter(proto, 'responseURL');
const xhrResponseType = protoGetter(proto, 'responseType');
const xhrResponseText = protoGetter(proto, 'responseText');
const xhrResponse = protoGetter(proto, 'response');
function readXhr(getter: ((this: unknown) => unknown) | undefined, xhr: XMLHttpRequest): unknown {
  return getter ? apply(getter, xhr, []) : undefined;
}

proto.open = function (this: XMLHttpRequest & { __ledgerUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
  try {
    this.__ledgerUrl = typeof url === 'string' ? url : String(url);
  } catch {
    /* ignore */
  }
  // @ts-expect-error — forwarding the native overload's variadic tail as-is.
  return nativeOpen.call(this, method, url, ...rest);
};

proto.send = function (this: XMLHttpRequest & { __ledgerUrl?: string }, ...args: unknown[]) {
  try {
    if (isMarket(this.__ledgerUrl)) {
      stats.seen++;
      this.addEventListener('load', (event: Event) => {
        try {
          // Only the browser's own load event, for a response that really
          // came back from an EA market URL (after redirects): a page script
          // can dispatch a synthetic 'load' on any XHR it likes.
          if (!event.isTrusted) return;
          const finalUrl = readXhr(xhrResponseURL, this);
          if (xhrResponseURL && !isMarket(finalUrl)) return;
          const type = readXhr(xhrResponseType, this);
          if (type === '' || type === 'text') {
            handleBody(this.__ledgerUrl as string, readXhr(xhrResponseText, this));
          } else if (type === 'json' && readXhr(xhrResponse, this)) {
            handleBody(this.__ledgerUrl as string, stringifyJson(readXhr(xhrResponse, this)));
          } else {
            stats.failed++;
            post('shape', { ...stats, reason: 'unreadable responseType: ' + type });
          }
        } catch {
          stats.failed++;
        }
      });
    }
  } catch {
    /* never break the app's own request */
  }
  // @ts-expect-error — forwarding the native overload's variadic args as-is.
  return nativeSend.apply(this, args);
};

// ---- fetch ------------------------------------------------------------------
const nativeFetch = window.fetch;
const ResponseProto = typeof Response === 'function' ? Response.prototype : undefined;
const responseUrl = protoGetter(ResponseProto, 'url');
const responseClone = ResponseProto?.clone;
const responseText = ResponseProto?.text;
if (typeof nativeFetch === 'function' && responseClone && responseText) {
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof Request ? input.url : input instanceof URL ? input.toString() : '';
    } catch {
      /* ignore */
    }

    // Called and observed through captured `Reflect.apply` and
    // `Promise.prototype.then`, so a page script that later hooks
    // `Function.prototype.call` or `Promise.prototype.then` cannot slip a
    // Response of its own into what the adapter records. The page gets the
    // native promise back untouched.
    const promise = apply(nativeFetch, window, [input, init]) as Promise<Response>;
    if (!isMarket(url)) return promise;

    stats.seen++;
    apply(promiseThen, promise, [
      (res: Response) => {
        try {
          // The final URL after redirects, read with the captured getter: a
          // market-looking request can still be answered from elsewhere, and
          // a Response built in script has no URL at all. Either way, not
          // recorded (fail closed).
          const finalUrl = responseUrl ? apply(responseUrl, res, []) : '';
          if (!isMarket(finalUrl)) return;
          const body = apply(responseText, apply(responseClone, res, []) as Response, []) as Promise<string>;
          apply(promiseThen, body, [
            (text: string) => handleBody(url, text),
            () => {
              stats.failed++;
            },
          ]);
        } catch {
          stats.failed++;
        }
      },
      () => undefined,
    ]);
    return promise;
  };
}

// ---- act surface (M2/M3) ---------------------------------------------------

/** `filterCriteria` (packages/shared/src/schemas/filters.ts) uses field
 * names that mirror the FC web app's own search form. This is the one place
 * that maps them onto the ASSUMED SHAPE's `search()` argument — see the
 * header comment above for what to fix first if EA's real field names
 * differ. Every field is optional both sides, so an empty filter just maps
 * to an empty criteria object (the app's own "browse everything" search). */
function mapFilterToSearchCriteria(filter: FilterCriteria): Record<string, unknown> {
  const criteria: Record<string, unknown> = {};
  if (filter.resourceId != null) criteria.resourceId = filter.resourceId;
  if (filter.minPrice != null) criteria.minBuy = filter.minPrice;
  if (filter.maxPrice != null) criteria.maxBuy = filter.maxPrice;
  if (filter.minRating != null) criteria.minRating = filter.minRating;
  if (filter.maxRating != null) criteria.maxRating = filter.maxRating;
  if (filter.position != null) criteria.position = filter.position;
  if (filter.nationality != null) criteria.nation = filter.nationality;
  if (filter.league != null) criteria.leagueId = filter.league;
  if (filter.club != null) criteria.teamId = filter.club;
  if (filter.quality != null) criteria.type = filter.quality;
  return criteria;
}

/** The assumed response envelope may nest the array under `auctionInfo`
 * (matching the passive UTAS shape) or `items` (a plausible alternate the
 * app's own repository layer could use for an already-deserialised result) —
 * guarded, first one present wins, empty array if neither is. */
function extractAuctionInfo(result: unknown): unknown[] {
  const r = result as Record<string, unknown> | null | undefined;
  if (Array.isArray(r?.auctionInfo)) return r.auctionInfo;
  if (Array.isArray(r?.items)) return r.items;
  return [];
}

async function actSearch(requestId: string, filter: FilterCriteria): Promise<void> {
  const requestedAt = Date.now();
  const probeResult = runProbeAndReport();
  if (!probeResult.ok) {
    postResult({ action: 'search', requestId, ok: false, requestedAt, completedAt: Date.now(), error: probeResult.reason });
    return;
  }
  try {
    const services = assumedServices();
    const search = services?.Item?.repository?.search;
    if (typeof search !== 'function') throw new Error('services.Item.repository.search vanished after probe() passed');
    const criteria = mapFilterToSearchCriteria(filter);
    const result = await search(criteria);
    emitAuctionInfo('act:search', extractAuctionInfo(result));
    postResult({ action: 'search', requestId, ok: true, requestedAt, completedAt: Date.now() });
  } catch (err) {
    postResult({
      action: 'search',
      requestId,
      ok: false,
      requestedAt,
      completedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Refuse unless the listing's buy-now price, as the adapter last saw it,
 * is exactly the price content expects to pay (see `lastSeenListings`). */
function priceCheck(tradeId: string, price: number, at: number): string | null {
  const listing = apply(mapGet, lastSeenListings, [tradeId]) as SeenListing | undefined;
  if (!listing || (listing.expiresAt != null && listing.expiresAt <= at)) return ACT_ERROR.listingUnknown;
  // buyNow 0 means the listing has no buy-now price: nothing to match.
  if (listing.buyNow <= 0 || listing.buyNow !== price) return ACT_ERROR.priceMismatch;
  return null;
}

async function actBuy(requestId: string, tradeId: string, price: number): Promise<void> {
  const requestedAt = now();
  const probeResult = runProbeAndReport();
  if (!probeResult.ok) {
    postResult({ action: 'buy', requestId, ok: false, requestedAt, completedAt: Date.now(), error: probeResult.reason });
    return;
  }
  const refusal = priceCheck(tradeId, price, requestedAt);
  if (refusal) {
    postResult({ action: 'buy', requestId, ok: false, requestedAt, completedAt: Date.now(), error: refusal });
    return;
  }
  try {
    const services = assumedServices();
    const buyNow = services?.Transfer?.repository?.buyNow;
    if (typeof buyNow !== 'function') throw new Error('services.Transfer.repository.buyNow vanished after probe() passed');
    const result = await buyNow(tradeId);
    const failed = !!result && typeof result === 'object' && (result as Record<string, unknown>).success === false;
    postResult({
      action: 'buy',
      requestId,
      ok: !failed,
      requestedAt,
      completedAt: Date.now(),
      error: failed ? 'buyNow resolved with success: false' : undefined,
    });
  } catch (err) {
    postResult({
      action: 'buy',
      requestId,
      ok: false,
      requestedAt,
      completedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function actReadResult(requestId: string, tradeId: string): Promise<void> {
  const requestedAt = Date.now();
  const probeResult = runProbeAndReport();
  if (!probeResult.ok) {
    postResult({ action: 'readResult', requestId, ok: false, requestedAt, completedAt: Date.now(), error: probeResult.reason });
    return;
  }
  try {
    const services = assumedServices();
    const search = services?.Item?.repository?.search;
    if (typeof search !== 'function') throw new Error('services.Item.repository.search vanished after probe() passed');
    const result = await search({ tradeIds: [tradeId] });
    const stillListed = extractAuctionInfo(result).some(
      (a) => a && typeof a === 'object' && String((a as Record<string, unknown>).tradeId) === String(tradeId),
    );
    postResult({ action: 'readResult', requestId, ok: true, requestedAt, completedAt: Date.now(), stillListed });
  } catch (err) {
    postResult({
      action: 'readResult',
      requestId,
      ok: false,
      requestedAt,
      completedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- the act channel listener -------------------------------------------------
//
// Any script on the page can post an `act_request`; only one carrying a
// valid MAC under this page load's nonce (lib/act-auth.ts) is acted on, and
// each requestId only once, so a request a page script watched go past
// cannot be replayed. Everything else is dropped silently — no reply, so a
// probing script learns nothing.

// Never pruned: requestIds are UUIDs and the governor keeps a page load to a
// few dozen acts an hour, so this stays tiny — and an evicted id would be a
// replayable one.
const consumedRequestIds = new Set<string>();

type ActRequest =
  | { action: 'search'; requestId: string; filter: FilterCriteria }
  | { action: 'buy'; requestId: string; tradeId: string; price: number }
  | { action: 'readResult'; requestId: string; tradeId: string };

// Keep in sync with `adapterActRequestMessageSchema` (packages/shared/src/
// ext-messages.ts): this file stays zod-free, so it re-checks the same shape
// by hand.
function asActRequest(value: unknown): ActRequest | null {
  const d = value as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || typeof d.requestId !== 'string' || d.requestId === '') return null;
  if (d.action === 'search') return d.filter && typeof d.filter === 'object' ? (d as unknown as ActRequest) : null;
  if (typeof d.tradeId !== 'string' || d.tradeId === '') return null;
  if (d.action === 'readResult') return d as unknown as ActRequest;
  if (d.action === 'buy') return isInteger(d.price) && (d.price as number) > 0 ? (d as unknown as ActRequest) : null;
  return null;
}

async function handleActRequest(data: unknown, mac: unknown): Promise<void> {
  const s = signer;
  if (!s) {
    // No key: nothing can be authenticated. Say so (unsigned — there is
    // nothing to sign with), so content fails fast instead of timing out.
    runProbeAndReport();
    return;
  }
  if (!(await s.verify(canonicalActMessage('act_request', data), mac))) return;
  const request = asActRequest(data);
  if (!request || apply(setHas, consumedRequestIds, [request.requestId])) return;
  apply(setAdd, consumedRequestIds, [request.requestId]);

  if (request.action === 'search') await actSearch(request.requestId, request.filter);
  else if (request.action === 'buy') await actBuy(request.requestId, request.tradeId, request.price);
  else await actReadResult(request.requestId, request.tradeId);
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as { channel?: string; kind?: string; data?: unknown; mac?: unknown } | null;
  if (!msg || msg.channel !== ADAPTER_CHANNEL || msg.kind !== 'act_request') return;
  // Snapshot synchronously, before any page listener on this same event
  // runs: page scripts share this event's `data` object and could otherwise
  // change it between the MAC check and the call it authorises. From here on
  // the adapter only reads its own copy.
  let data: unknown;
  try {
    data = parseJson(canonicalize(msg.data));
  } catch {
    return;
  }
  void handleActRequest(data, msg.mac);
});

post('ready', { channel: ADAPTER_CHANNEL });
runProbeAndReport();
