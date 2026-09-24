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
import { scrubText } from '../lib/redact.js';

import { createAdapterLog, describeKeys } from './diagnostics.js';
import { normaliseListing, normaliseListings, type NormalisedListing } from './ea-listing.js';
import { selectShape, type ShapeName, type ShapeSelection } from './shapes.js';

import type { AdapterDiagnostics, FilterCriteria, TrimmedAuction } from '@sl/shared';

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
const isFiniteNumber = Number.isFinite;
const isInteger = Number.isInteger;
const now = Date.now;
const URLCtor = URL;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapClear = Map.prototype.clear;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const promiseThen = Promise.prototype.then;
function protoGetter(proto: object | undefined, name: string): ((this: unknown) => unknown) | undefined {
  return proto ? (Object.getOwnPropertyDescriptor(proto, name)?.get as ((this: unknown) => unknown) | undefined) : undefined;
}

/* ------------------------------------------------------------------------ *
 * ASSUMED SHAPES — verify on day one
 *
 * The live EA FC web app is unreachable while the market is locked (see
 * docs/06-extension.md, "Day-one verification checklist"), so the act
 * surface below is written against *documented assumptions*, not observed
 * fact. There are two candidate shapes for EA's service layer, each in its
 * own module (main/shapes.ts has the list):
 *
 *   - observable (main/shape-observable.ts), what community autobuyers
 *     describe: `services.Item.searchTransferMarket(criteria, page)` and
 *     `services.Item.bid(item, price)`, answering via `.observe(...)`;
 *   - promise (main/shape-promise.ts), this file's original assumption:
 *     `services.Item.repository.search(criteria)` and
 *     `services.Transfer.repository.buyNow(tradeId)`, returning promises.
 *
 * `probe()` selects whichever the page has, re-checked before every act
 * call (never cached — the point is to catch a bundle update mid-session).
 * With neither, `probe()` fails closed: `ok: false` with a `reason` naming
 * what each candidate was missing, the engine hard-stops before calling
 * `act.search`/`act.buy`, and the panel goes amber. Every lookup is guarded
 * (`typeof x === 'function'` before calling anything), so a missing or
 * renamed property is a clean probe failure, never a thrown exception.
 *
 * Whatever a call returns goes through main/ea-response.ts (an observable
 * is observed, a promise awaited) and main/ea-listing.ts (entities and
 * UTAS JSON normalised to one listing shape). A response that yields no
 * list, or only unreadable entries, is an error — never `ok` with nothing
 * in it. Fixing a real mismatch means editing a shape module (or adding
 * one); nowhere outside `src/main/` knows EA's shape at all, by design
 * (docs/01-architecture.md, "never-forge-a-request seam").
 * ------------------------------------------------------------------------ */

function servicesRoot(): unknown {
  return (window as unknown as { services?: unknown }).services;
}

interface ProbeResult {
  ok: boolean;
  reason?: string;
  shape?: ShapeName;
}

/** The adapter's own log (last 50 lines, scrubbed): part of the
 * diagnostics report, and nowhere else. */
const adapterLog = createAdapterLog(50, now);
let lastProbeSummary = '';

/** Select the service-layer shape the page has. Called once at load and
 * again before every single `act` call (docs/01-architecture.md, §3.5). */
function probe(): { result: ProbeResult; selection: ShapeSelection } {
  const selection = selectShape(servicesRoot());
  const result: ProbeResult = selection.shape ? { ok: true, shape: selection.shape.name } : { ok: false, reason: selection.reason };
  // Logged on change only, so a failing probe re-run before every act call
  // does not push everything else out of the 50-line log.
  const summary = result.ok ? `probe ok: shape ${result.shape}` : `probe failed: ${result.reason}`;
  if (summary !== lastProbeSummary) {
    lastProbeSummary = summary;
    adapterLog.add(summary);
  }
  return { result, selection };
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
function post(kind: 'probe', data: { ok: boolean; checkedAt: number; reason?: string; shape?: ShapeName; actReady: boolean }): void;
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
  action: 'search' | 'buy' | 'readResult' | 'diagnostics';
  requestId: string;
  ok: boolean;
  requestedAt: number;
  completedAt: number;
  error?: string;
  stillListed?: boolean;
  diagnostics?: AdapterDiagnostics;
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

function runProbeAndReport(): { result: ProbeResult; selection: ShapeSelection } {
  const outcome = probe();
  const result = outcome.result;
  // `actReady: false` means no nonce reached this adapter, so no act request
  // can ever be authenticated. Unsigned, so content treats it only as a
  // hint: a call that then times out is reported as adapter_unauthenticated
  // (not retried) rather than as a plain timeout (content/adapter-client.ts).
  post('probe', { ...result, checkedAt: Date.now(), actReady: signer !== null });
  return outcome;
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
function trimAuction(a: NormalisedListing, seenAt: number): TrimmedAuction {
  return {
    tradeId: a.tradeId,
    resourceId: a.resourceId,
    assetId: a.assetId,
    rating: a.rating,
    buyNow: a.buyNowPrice,
    startingBid: a.startingBid,
    currentBid: a.currentBid,
    offers: a.offers,
    // expires arrives as seconds remaining; an absolute time is what we can compare later
    expiresAt: a.expires != null && isFiniteNumber(a.expires) ? seenAt + a.expires * 1000 : null,
    seenAt,
  };
}

/** Trim + emit normalised listings through the same 'auctions' message
 * passive observation uses, whether they came from a patched network
 * response or from `act.search()` driving EA's own service — one pipeline,
 * one privacy seam, regardless of source. `entities`, when given, is the
 * list the listings were read from, kept for shapes that buy on the entity
 * (main/shape-observable.ts). */
function emitListings(url: string, listings: NormalisedListing[], entities?: Map<string, unknown>): TrimmedAuction[] {
  const seenAt = now();
  const auctions: TrimmedAuction[] = [];
  for (let i = 0; i < listings.length; i++) {
    const trimmed = trimAuction(listings[i]!, seenAt);
    auctions[auctions.length] = trimmed;
    rememberListing(trimmed, entities ? apply(mapGet, entities, [trimmed.tradeId]) : undefined);
  }
  stats.parsed++;
  post('auctions', { url, seenAt, auctions, stats: { ...stats } });
  return auctions;
}

/** The last market response the adapter read, for the diagnostics report
 * (described there by key names and types only — never stored as text). */
let lastMarketResponse: { source: string; at: number; value: unknown } | null = null;

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
  /** The item entity an act search returned for this listing, for shapes
   * that buy on the entity. Absent for a listing only seen passively. */
  entity?: unknown;
}
const MAX_REMEMBERED_LISTINGS = 5000;
const lastSeenListings = new Map<string, SeenListing>();
let rememberedListings = 0;

function rememberListing(a: TrimmedAuction, entity: unknown): void {
  const previous = apply(mapGet, lastSeenListings, [a.tradeId]) as SeenListing | undefined;
  if (!previous) {
    if (++rememberedListings > MAX_REMEMBERED_LISTINGS) {
      apply(mapClear, lastSeenListings, []);
      rememberedListings = 1;
    }
  }
  // A passive sighting after an act search keeps the entity: it is still
  // the same listing (a relist gets a new tradeId).
  const keep = entity ?? previous?.entity;
  apply(mapSet, lastSeenListings, [a.tradeId, keep === undefined ? { buyNow: a.buyNow, expiresAt: a.expiresAt } : { buyNow: a.buyNow, expiresAt: a.expiresAt, entity: keep }]);
}

function handleBody(url: string, body: unknown): void {
  if (typeof body !== 'string' || body.length === 0) {
    shapeFailure('empty body');
    return;
  }

  let payload: unknown;
  try {
    payload = parseJson(body);
  } catch {
    shapeFailure('response was not JSON');
    return;
  }

  lastMarketResponse = { source: 'passive', at: now(), value: payload };
  const auctionInfo = (payload as Record<string, unknown> | null)?.auctionInfo;
  if (!payload || !Array.isArray(auctionInfo)) {
    // A market call with no auctionInfo is how a payload change first shows up.
    shapeFailure('no auctionInfo array in response');
    return;
  }

  let listings: NormalisedListing[];
  try {
    listings = normaliseListings(auctionInfo);
  } catch (err) {
    // Entries there, none readable: the same payload change, one level down.
    shapeFailure(err instanceof Error ? err.message : String(err));
    return;
  }
  emitListings(String(url).split('?')[0] ?? url, listings);
}

function shapeFailure(reason: string): void {
  stats.failed++;
  adapterLog.add(`passive: ${reason}`);
  post('shape', { ...stats, reason });
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
            shapeFailure('unreadable responseType: ' + type);
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
//
// Each act call re-runs the probe, then goes through the selected shape
// (main/shapes.ts). Every error, and every refusal, is also written to the
// adapter's log for the diagnostics report.

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Post a failed result, and log it. */
function fail(action: ActionResult['action'], requestId: string, requestedAt: number, error: string | undefined): void {
  adapterLog.add(`${action} failed: ${error ?? 'unknown error'}`);
  postResult({ action, requestId, ok: false, requestedAt, completedAt: now(), error });
}

async function actSearch(requestId: string, filter: FilterCriteria): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('search', requestId, requestedAt, result.reason);
  try {
    const { response, entries } = await shape.search(servicesRoot() as Record<string, unknown>, filter);
    lastMarketResponse = { source: 'act:search', at: now(), value: response };
    const listings = normaliseListings(entries);
    let entities: Map<string, unknown> | undefined;
    if (shape.buysOnEntity) {
      // Keep each readable entry by its tradeId: this shape's buy acts on
      // the entity itself (main/shape-observable.ts).
      entities = new Map();
      for (let i = 0; i < entries.length; i++) {
        const tradeId = normaliseListing(entries[i])?.tradeId;
        if (tradeId) apply(mapSet, entities, [tradeId, entries[i]]);
      }
    }
    emitListings('act:search', listings, entities);
    adapterLog.add(`search ok (${shape.name}): ${listings.length} listings`);
    postResult({ action: 'search', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    fail('search', requestId, requestedAt, errorText(err));
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
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('buy', requestId, requestedAt, result.reason);
  const refusal = priceCheck(tradeId, price, requestedAt);
  if (refusal) return fail('buy', requestId, requestedAt, refusal);
  const entity = (apply(mapGet, lastSeenListings, [tradeId]) as SeenListing | undefined)?.entity;
  if (shape.buysOnEntity && entity === undefined) return fail('buy', requestId, requestedAt, ACT_ERROR.listingEntityUnknown);
  try {
    await shape.buy(servicesRoot() as Record<string, unknown>, { tradeId, price, entity });
    adapterLog.add(`buy ok (${shape.name})`);
    postResult({ action: 'buy', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    fail('buy', requestId, requestedAt, errorText(err));
  }
}

async function actReadResult(requestId: string, tradeId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('readResult', requestId, requestedAt, result.reason);
  try {
    const stillListed = await shape.readResult(servicesRoot() as Record<string, unknown>, tradeId);
    postResult({ action: 'readResult', requestId, ok: true, requestedAt, completedAt: now(), stillListed });
  } catch (err) {
    fail('readResult', requestId, requestedAt, errorText(err));
  }
}

/** The diagnostics report (options page, "Copy diagnostics";
 * docs/06-extension.md §4). Read-only: it reads property descriptors and
 * the adapter's own state, and calls nothing of EA's. Values never go in —
 * key names and types, counters, and the adapter's scrubbed log. */
function diagnosticsReport(): AdapterDiagnostics {
  const { result, selection } = probe();
  const services = servicesRoot();
  const last = lastMarketResponse;
  return {
    probe: {
      ok: result.ok,
      reason: result.reason === undefined ? undefined : scrubText(result.reason).slice(0, 2000),
      shape: result.shape ?? null,
      checkedAt: now(),
    },
    candidates: selection.candidates.map((c) =>
      c.reason === undefined ? { shape: c.shape, present: c.present } : { shape: c.shape, present: c.present, reason: scrubText(c.reason).slice(0, 500) },
    ),
    servicesKeys: describeKeys(services, 3),
    globals: {
      services: services === null ? 'null' : typeof services,
      UTSearchCriteriaDTO: typeof (window as unknown as Record<string, unknown>).UTSearchCriteriaDTO,
    },
    lastMarketResponse: last ? { source: last.source, at: last.at, shape: describeKeys(last.value, 6) } : null,
    stats: { ...stats },
    log: adapterLog.lines(),
  };
}

function actDiagnostics(requestId: string): void {
  const requestedAt = now();
  try {
    adapterLog.add('diagnostics requested');
    postResult({ action: 'diagnostics', requestId, ok: true, requestedAt, completedAt: now(), diagnostics: diagnosticsReport() });
  } catch (err) {
    fail('diagnostics', requestId, requestedAt, errorText(err));
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
  | { action: 'readResult'; requestId: string; tradeId: string }
  | { action: 'diagnostics'; requestId: string };

// Keep in sync with `adapterActRequestMessageSchema` (packages/shared/src/
// ext-messages.ts): this file stays zod-free, so it re-checks the same shape
// by hand.
function asActRequest(value: unknown): ActRequest | null {
  const d = value as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || typeof d.requestId !== 'string' || d.requestId === '') return null;
  if (d.action === 'search') return d.filter && typeof d.filter === 'object' ? (d as unknown as ActRequest) : null;
  if (d.action === 'diagnostics') return d as unknown as ActRequest;
  if (typeof d.tradeId !== 'string' || d.tradeId === '') return null;
  if (d.action === 'readResult') return d as unknown as ActRequest;
  if (d.action === 'buy') return isInteger(d.price) && (d.price as number) > 0 ? (d as unknown as ActRequest) : null;
  return null;
}

async function handleActRequest(data: unknown, mac: unknown): Promise<void> {
  const s = signer;
  if (!s) {
    // No key: nothing can be authenticated. Say so (unsigned — there is
    // nothing to sign with), so content does not retry the timeout.
    runProbeAndReport();
    return;
  }
  if (!(await s.verify(canonicalActMessage('act_request', data), mac))) return;
  const request = asActRequest(data);
  if (!request || apply(setHas, consumedRequestIds, [request.requestId])) return;
  apply(setAdd, consumedRequestIds, [request.requestId]);

  if (request.action === 'search') await actSearch(request.requestId, request.filter);
  else if (request.action === 'buy') await actBuy(request.requestId, request.tradeId, request.price);
  else if (request.action === 'readResult') await actReadResult(request.requestId, request.tradeId);
  else actDiagnostics(request.requestId);
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
