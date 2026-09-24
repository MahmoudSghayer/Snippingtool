/*
 * adapter.ts — the ONLY file that knows anything about EA's internals.
 *
 * Runs in the page's MAIN world (manifest: world "MAIN", document_start;
 * the userscript injects it at document-start, src/userscript/setup.ts) so
 * it can see the web app's own network calls and, from M2 onward, its own
 * service layer. Three jobs, all governed by the same rule — never issue a
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
 *   3. The catalog (automation builds only): the Sniping Bot's Snipe
 *      Targets choices, built with the app's own lists and images
 *      (main/catalog-builder.ts). Asked for with an authenticated
 *      `act_request`, and sent back only as a `catalog` message signed
 *      under the same nonce, so no page script can feed the bot's form.
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

import { createCatalogBuilder } from './catalog-builder.js';
import { createAdapterLog, describeKeys } from './diagnostics.js';
import { normaliseListing, normaliseListings, type NormalisedListing } from './ea-listing.js';
import { TimeoutUnknownError, describeError, extractListingArray } from './ea-response.js';
import { createSearchHook } from './search-hook.js';
import { selectShape, type ServiceShape, type ShapeName, type ShapeSelection } from './shapes.js';

import type { Catalog } from '../model/catalog.js';
import type { AdapterDiagnostics, FilterCriteria, TrimmedAuction } from '@sl/shared';

/** The userscript build injects this file into the page itself; see the
 * act channel listener at the bottom for the one thing that changes. */
const USERSCRIPT_BUILD = import.meta.env.VITE_BUILD_TARGET === 'userscript';
/** Only automation builds have the Sniping Bot page the catalog is for:
 * the listable `ledger` build never builds one or fetches EA's data files. */
const CATALOG_ENABLED = import.meta.env.VITE_AUTOMATION === '1';

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
const setTimer = setTimeout;
const SEARCH_HOOK_RECHECK_MS = 2000;
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
  ensureSearchHook(selection);
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
function post(kind: 'listings_buyable', data: { tradeIds: string[] }): void;
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
  /** A second result for a buy that first came back `timeout_unknown`:
   * EA's answer arrived after all (lib/act-auth.ts). */
  late?: boolean;
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

/** The catalog goes out signed too, like `action_result`: it fills the
 * Sniping Bot's target form, and a page script must not be able to choose
 * what the user picks from. No key, nothing sent. */
function postCatalog(catalog: Catalog): void {
  const s = signer;
  if (!s) return;
  const data = { catalog };
  s.sign(canonicalActMessage('catalog', data)).then(
    (mac) => {
      try {
        window.postMessage({ channel: ADAPTER_CHANNEL, kind: 'catalog', data, mac }, window.location.origin);
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
/** Where a batch of listings came from, for `isSecondSighting`: the
 * network (passive observation; `actIssued` when the market request went
 * out while one of the adapter's act searches was in flight, so it is
 * that search's own), or an act search (with when it started). */
type BatchSource = { kind: 'passive'; actIssued: boolean } | { kind: 'act'; requestedAt: number };

function emitListings(url: string, listings: NormalisedListing[], source: BatchSource, entities?: Map<string, unknown>): TrimmedAuction[] {
  const seenAt = now();
  const auctions: TrimmedAuction[] = [];
  // `buyable` tells content up front which listings a buy could go through
  // for, so it never spends an attempt on one the adapter would refuse
  // (engine/ranker.ts drops the rest). Under no shape at all, nothing is.
  const shape: ServiceShape | null = selectShape(servicesRoot()).shape;
  for (let i = 0; i < listings.length; i++) {
    const trimmed = trimAuction(listings[i]!, seenAt);
    const seen = rememberListing(trimmed, entities ? apply(mapGet, entities, [trimmed.tradeId]) : undefined);
    trimmed.buyable = shape !== null && (!shape.buysOnEntity || seen.entity !== undefined);
    auctions[auctions.length] = trimmed;
  }
  stats.parsed++;
  // A search the adapter issued itself reaches it twice: as its act search
  // result, and as the network response passive observation sees, in
  // either order. Content counts every `auctions` message as a search
  // (governor, ledger rows, telemetry, the panel), so that second sighting
  // is not posted again: the listings are remembered above, and only a
  // buyable upgrade goes out. Nothing else is ever merged.
  if (isSecondSighting(auctions, seenAt, source)) {
    postBuyable(auctions.filter((a) => a.buyable).map((a) => a.tradeId));
    return auctions;
  }
  post('auctions', { url, seenAt, auctions, stats: { ...stats } });
  return auctions;
}

/** How long after an act search completes its own network response may
 * still arrive (passive observation's load listener can run after the
 * service's observable has already called back). */
const ACT_NETWORK_GRACE_MS = 5000;
/** Act searches in flight right now. A market request *sent* while one is
 * running is tagged as that search's own (`actIssued`, at send time in the
 * XHR/fetch patches below). */
let actSearchesInFlight = 0;

interface RecentBatch {
  key: string;
  at: number;
  kind: 'passive' | 'act';
  /** Already matched with its other half: a batch pairs once. */
  paired?: boolean;
}
let recentBatches: RecentBatch[] = [];

/**
 * Whether this batch is the second sighting of one act search: the act
 * result, and the network response to a market request the act search
 * itself sent (tagged `actIssued` when it went out), with the same
 * tradeIds, in either order. Each batch pairs at most once, and an untagged
 * network response never pairs: passive/passive and act/act are never
 * merged, so two human searches with the same (often empty) results are
 * two searches, and every one counts toward the governor's actionsPerHour.
 */
function isSecondSighting(auctions: TrimmedAuction[], at: number, source: BatchSource): boolean {
  if (source.kind === 'passive' && !source.actIssued) return false;
  const key = auctions
    .map((a) => a.tradeId)
    .sort()
    .join(',');
  recentBatches = recentBatches.filter((b) => at - b.at < 30_000);
  const match =
    source.kind === 'act'
      ? recentBatches.find((b) => !b.paired && b.kind === 'passive' && b.key === key && b.at >= source.requestedAt)
      : recentBatches.find((b) => !b.paired && b.kind === 'act' && b.key === key && at - b.at <= ACT_NETWORK_GRACE_MS);
  if (match) {
    match.paired = true;
    return true;
  }
  recentBatches.push({ key, at, kind: source.kind });
  return false;
}

/** Tell content these already-reported listings are now buyable (the
 * observable shape saw their entities). Not a search: content applies it
 * without counting or recording anything. */
function postBuyable(tradeIds: string[]): void {
  if (tradeIds.length > 0) post('listings_buyable', { tradeIds: tradeIds.slice(0, 500) });
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

function rememberListing(a: TrimmedAuction, entity: unknown): SeenListing {
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
  const seen: SeenListing = keep === undefined ? { buyNow: a.buyNow, expiresAt: a.expiresAt } : { buyNow: a.buyNow, expiresAt: a.expiresAt, entity: keep };
  apply(mapSet, lastSeenListings, [a.tradeId, seen]);
  return seen;
}

/** A mixed page: some entries unreadable. Not a failed response (the rest
 * are recorded), but counted and logged, so a partial shape change shows. */
function skippedEntries(source: string): (count: number) => void {
  return (count) => {
    stats.failed++;
    adapterLog.add(`${source}: skipped ${count} unreadable entries`);
  };
}

// ---- the observable shape's search hook (main/search-hook.ts) -------------

/** A search the page itself ran, seen through the hook: keep its entities,
 * so the observable shape can buy those listings. An unreadable response
 * is only logged; the page's search is not ours to fail, and passive
 * observation reports the network side anyway. */
function onHookedSearch(response: unknown): void {
  let entries: unknown[];
  let listings: NormalisedListing[];
  try {
    entries = extractListingArray(response, { requireSuccess: true });
    listings = normaliseListings(entries, skippedEntries('hook'));
  } catch (err) {
    adapterLog.add(`hook: ${describeError(err)}`);
    return;
  }
  lastMarketResponse = { source: 'hook:search', at: now(), value: response };
  // Not a search of its own: passive observation reports this search once,
  // from the network. The hook only keeps the entities (so passive's report
  // says buyable if it comes second) and upgrades the listings if passive
  // already reported them.
  const entities = entitiesByTradeId(entries);
  const seenAt = now();
  const upgraded: string[] = [];
  // Buyable only under a selected shape that buys on entities, as in
  // `emitListings`: the hook can outlive the shape it was installed for.
  const shape = selectShape(servicesRoot()).shape;
  if (!shape || !shape.buysOnEntity) return;
  for (let i = 0; i < listings.length; i++) {
    const trimmed = trimAuction(listings[i]!, seenAt);
    const entity = apply(mapGet, entities, [trimmed.tradeId]);
    if (entity === undefined) continue;
    rememberListing(trimmed, entity);
    upgraded[upgraded.length] = trimmed.tradeId;
  }
  postBuyable(upgraded);
}

const searchHook = createSearchHook(onHookedSearch);

function ensureSearchHook(selection: ShapeSelection): void {
  if (selection.shape?.name !== 'observable') return;
  if (!searchHook.isInstalled(servicesRoot()) && searchHook.ensure(servicesRoot())) adapterLog.add('search hook installed');
}

/** Each readable entry by its tradeId: the observable shape's buy acts on
 * the entity itself (main/shape-observable.ts). */
function entitiesByTradeId(entries: unknown[]): Map<string, unknown> {
  const entities = new Map<string, unknown>();
  for (let i = 0; i < entries.length; i++) {
    const tradeId = normaliseListing(entries[i])?.tradeId;
    if (tradeId) apply(mapSet, entities, [tradeId, entries[i]]);
  }
  return entities;
}

function handleBody(url: string, body: unknown, actIssued: boolean): void {
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
    listings = normaliseListings(auctionInfo, skippedEntries('passive'));
  } catch (err) {
    // Entries there, none readable: the same payload change, one level down.
    shapeFailure(err instanceof Error ? err.message : String(err));
    return;
  }
  emitListings(String(url).split('?')[0] ?? url, listings, { kind: 'passive', actIssued });
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
      // Tagged at send time: a request that goes out during one of the
      // adapter's act searches is that search's own (isSecondSighting).
      const actIssued = actSearchesInFlight > 0;
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
            handleBody(this.__ledgerUrl as string, readXhr(xhrResponseText, this), actIssued);
          } else if (type === 'json' && readXhr(xhrResponse, this)) {
            handleBody(this.__ledgerUrl as string, stringifyJson(readXhr(xhrResponse, this)), actIssued);
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
    const actIssued = actSearchesInFlight > 0; // see the XHR patch above
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
            (text: string) => handleBody(url, text, actIssued),
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

// ---- the catalog (main/catalog-builder.ts) ----------------------------------

/** One of the web app's public JSON files, through the `fetch` captured at
 * load (same-origin, so the page's own; not a market call). */
async function getJson(url: string): Promise<unknown> {
  const res = (await apply(nativeFetch, window, [url, { credentials: 'same-origin' }])) as Response;
  if (!res.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${res.status}`);
  // Some of the web app's JSON files start with a byte-order mark.
  return parseJson((await res.text()).replace(/^\uFEFF/, ''));
}

const catalogBuilder = CATALOG_ENABLED ? createCatalogBuilder(getJson) : null;
let catalogComplete = !CATALOG_ENABLED;
let catalogPostedOnce = false;

/** Builds what it can now and sends it (signed): always when content asked
 * (`force`), else only when there is something new — the first catalog, or
 * the one with EA's own lists in. */
async function refreshCatalog(force: boolean): Promise<void> {
  if (!catalogBuilder) return;
  const { catalog, complete } = await catalogBuilder.refresh();
  if (!catalog) return;
  const changed = !catalogPostedOnce || complete !== catalogComplete;
  catalogComplete = complete;
  if (!force && !changed) return;
  catalogPostedOnce = true;
  postCatalog(catalog);
}

// ---- act surface (M2/M3) ---------------------------------------------------
//
// Each act call re-runs the probe, then goes through the selected shape
// (main/shapes.ts). Every error, and every refusal, is also written to the
// adapter's log for the diagnostics report.

/** What content hears about a failed call: the message as before (the
 * autobuyer matches EA's "sold"/"expired" wording in it). */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Post a failed result, and log it. The log gets `logText` when given —
 * `describeError`'s allowlist for anything EA's code threw, never EA's own
 * message text, which could quote a coin balance. */
function fail(action: ActionResult['action'], requestId: string, requestedAt: number, error: string | undefined, logText?: string): void {
  adapterLog.add(`${action} failed: ${logText ?? error ?? 'unknown error'}`);
  postResult({ action, requestId, ok: false, requestedAt, completedAt: now(), error });
}

async function actSearch(requestId: string, filter: FilterCriteria): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('search', requestId, requestedAt, result.reason);
  try {
    // `unhooked`: the search hook stands aside for our own search, which is
    // recorded right here (the call into EA is synchronous; see
    // main/search-hook.ts).
    const services = servicesRoot() as Record<string, unknown>;
    actSearchesInFlight++;
    let searched: { response: unknown; entries: unknown[] };
    try {
      searched = await searchHook.unhooked(() => shape.search(services, filter));
    } finally {
      actSearchesInFlight--;
    }
    const { response, entries } = searched;
    lastMarketResponse = { source: 'act:search', at: now(), value: response };
    const listings = normaliseListings(entries, skippedEntries('search'));
    emitListings('act:search', listings, { kind: 'act', requestedAt }, shape.buysOnEntity ? entitiesByTradeId(entries) : undefined);
    adapterLog.add(`search ok (${shape.name}): ${listings.length} listings`);
    postResult({ action: 'search', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    fail('search', requestId, requestedAt, errorText(err), describeError(err));
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
    await shape.buy(servicesRoot() as Record<string, unknown>, {
      tradeId,
      price,
      entity,
      // EA answered after we reported `timeout_unknown`: say how it went,
      // in a second signed result content is waiting for.
      onLate: (bought) => {
        adapterLog.add(`late buy answer (${shape.name}): ${bought ? 'bought' : 'not bought'}`);
        postResult({ action: 'buy', requestId, ok: bought, late: true, requestedAt, completedAt: now() });
      },
    });
    adapterLog.add(`buy ok (${shape.name})`);
    postResult({ action: 'buy', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    if (err instanceof TimeoutUnknownError) {
      fail('buy', requestId, requestedAt, ACT_ERROR.timeoutUnknown, `${ACT_ERROR.timeoutUnknown}: ${err.message}`);
      return;
    }
    fail('buy', requestId, requestedAt, errorText(err), describeError(err));
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
    fail('readResult', requestId, requestedAt, errorText(err), describeError(err));
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
      searchHook: searchHook.isInstalled(services) ? 'installed' : 'not installed',
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
    fail('diagnostics', requestId, requestedAt, errorText(err), describeError(err));
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
  | { action: 'diagnostics'; requestId: string }
  | { action: 'catalog'; requestId: string };

// Keep in sync with `adapterActRequestMessageSchema` (packages/shared/src/
// ext-messages.ts): this file stays zod-free, so it re-checks the same shape
// by hand.
function asActRequest(value: unknown): ActRequest | null {
  const d = value as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || typeof d.requestId !== 'string' || d.requestId === '') return null;
  if (d.action === 'search') return d.filter && typeof d.filter === 'object' ? (d as unknown as ActRequest) : null;
  if (d.action === 'diagnostics' || d.action === 'catalog') return d as unknown as ActRequest;
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
  else if (request.action === 'catalog') await refreshCatalog(true);
  else actDiagnostics(request.requestId);
}

window.addEventListener('message', (event: MessageEvent) => {
  // The extension's content script shares this window, so its messages come
  // from this exact window object; anything else is dropped. The userscript
  // posts from Tampermonkey's sandbox through `unsafeWindow`, whose
  // messages need not carry this object as their source, so that build
  // (and only that build) checks the origin instead. Either way the MAC
  // below is what authenticates a request.
  if (USERSCRIPT_BUILD ? event.origin !== window.location.origin : event.source !== window) return;
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
// `window.services` appears some time after document_start, and the page
// may rebuild it; the probe installs the search hook whenever it runs, and
// this keeps checking between act calls so the human's first searches are
// seen too. A few property reads every couple of seconds.
setTimer(function recheck() {
  try {
    ensureSearchHook(selectShape(servicesRoot()));
  } catch {
    /* never break the page */
  }
  setTimer(recheck, SEARCH_HOOK_RECHECK_MS);
}, SEARCH_HOOK_RECHECK_MS);

// The web app starts after this script (document_start), and its data only
// loads after login; content.js starts listening at document_idle. So the
// probe is reported again as soon as it passes (or after a while, so a
// failure is reported too), and the catalog is sent as soon as its first
// layer can be built and again once the web app's own lists are in.
const STARTUP_POLL_MS = 2_000;
const STARTUP_GIVE_UP_MS = 10 * 60_000;
const startedAt = now();
let startupProbeReported = false;
const startup = setInterval(() => {
  try {
    const expired = now() - startedAt > STARTUP_GIVE_UP_MS;
    if (!startupProbeReported && (probe().result.ok || expired)) {
      startupProbeReported = true;
      runProbeAndReport();
    }
    if (!catalogComplete) void refreshCatalog(false).catch(() => undefined);
    if ((startupProbeReported && catalogComplete) || expired) clearInterval(startup);
  } catch {
    /* never break the page */
  }
}, STARTUP_POLL_MS);
