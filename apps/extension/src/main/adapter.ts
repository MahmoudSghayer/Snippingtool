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
 *      Automation builds add Nova AI's acts on the same terms: `list`
 *      (auto-sell), `pile` (reload the transfer list) and Bid mode's
 *      `bid`, `watchlist` and `move` — a bid only at exactly the next
 *      valid bid on an auction this file saw itself, and a list or move
 *      only of a card it bought or won on this page load.
 *   3. The catalog (automation builds only): the Sniping Bot's Snipe
 *      Targets choices, built with the app's own lists and images
 *      (main/catalog-builder.ts). Asked for with an authenticated
 *      `act_request`, and sent back only as a `catalog` message signed
 *      under the same nonce, so no page script can forge or alter the
 *      message itself. What goes into it is read in this MAIN world, which
 *      page scripts share: the builder pins the `fut_*` globals it reads at
 *      document_start, fetches only https URLs on EA hosts, and keeps only
 *      EA-hosted images, and content validates the catalog against the
 *      strict schema — but a page script that hooks EA's own list
 *      functions can still skew the names in it (docs/threat-model.md §3.1).
 *
 * When EA reshuffles their bundle, this is the one file that breaks — and it
 * is written to break LOUDLY. Passive observation reports every market call
 * it sees and every one it successfully parsed (`kind: 'shape'` when a
 * successful answer's JSON no longer fits). An EA *error* — any status
 * outside 2xx, EA's error envelope, an empty answer — is not a shape change
 * and goes out as `kind: 'ea_error'` with what kind of error it is (an
 * expired session, a captcha, a rate limit...). The act surface
 * additionally runs a *bundle probe* before it will do anything at all —
 * see below.
 */
// `ADAPTER_CHANNEL` comes from the zod-free `adapter-channel.js` subpath, not
// the `@sl/shared` barrel — this file runs in the page's MAIN world on every
// matching load, so it deliberately avoids pulling `zod` and every schema in
// `ext-messages.ts` along with it just for one string constant (see
// packages/shared/src/adapter-channel.ts).
import { ADAPTER_CHANNEL, eaErrorCategory } from '@sl/shared/adapter-channel.js';

import { ACT_ERROR, canonicalActMessage, canonicalize, createActSigner, takeHandedOffNonce, type ActSigner } from '../lib/act-auth.js';
import { scrubText } from '../lib/redact.js';

import { createCatalogBuilder } from './catalog-builder.js';
import { createAdapterLog, describeKeys } from './diagnostics.js';
import {
  nextBidPrice,
  normaliseListing,
  normaliseListings,
  normalisePileItem,
  normalisePileItems,
  normaliseWatchedItem,
  normaliseWatchedItems,
  type NormalisedListing,
} from './ea-listing.js';
import { TimeoutUnknownError, describeError, errorEnvelopeStatus, extractListingArray, isOkStatus } from './ea-response.js';
import { createSearchHook } from './search-hook.js';
import { selectShape, type SearchOptions, type ServiceShape, type ShapeName, type ShapeSelection } from './shapes.js';

import type { Catalog } from '../model/catalog.js';
import type {
  AdapterDiagnostics,
  EaErrorCategory,
  EaErrorEndpoint,
  FilterCriteria,
  TradePileItem,
  TrimmedAuction,
  WatchedAuction,
} from '@sl/shared';

/** The userscript build injects this file into the page itself; see the
 * act channel listener at the bottom for the one thing that changes. */
const USERSCRIPT_BUILD = import.meta.env.VITE_BUILD_TARGET === 'userscript';
/** Only automation builds have the Sniping Bot page the catalog is for:
 * the listable `ledger` build never builds one or fetches EA's data files. */
const CATALOG_ENABLED = import.meta.env.VITE_AUTOMATION === '1';
/** Likewise only automation builds list what Nova AI bought (auto-sell):
 * the listable build has no `list` act at all. */
const LISTING_ENABLED = import.meta.env.VITE_AUTOMATION === '1';
/** ...and only they have Nova AI's Bid mode: the `bid`, `watchlist` and
 * `move` acts. */
const BIDDING_ENABLED = import.meta.env.VITE_AUTOMATION === '1';

// ---- act-channel authentication (docs/09-security.md §13) --------------------
// Taken first thing, at `document_start`, before any page script exists:
// the per-page-load nonce content/handoff.ts left on <html>. Only the HMAC
// key derived from it is kept, inside `signer`'s closure; the attribute is
// removed as it is read. With no nonce, `signer` stays null and every
// act_request is ignored — passive observation keeps working regardless.
let signer: ActSigner | null = null;
takeHandedOffNonce(
  document,
  (nonce) => {
    signer = createActSigner(nonce);
  },
  // The userscript hands off synchronously, never late (lib/act-auth.ts).
  { lateFallback: !USERSCRIPT_BUILD },
);

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
const isArray = Array.isArray;
const now = Date.now;
const URLCtor = URL;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete;
const mapClear = Map.prototype.clear;
const mapKeys = Map.prototype.keys;
const mapSize = protoGetter(Map.prototype, 'size')!;
const mapIteratorNext = (Object.getPrototypeOf(new Map().keys()) as Iterator<unknown>).next;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const promiseThen = Promise.prototype.then;
const setTimer = setTimeout;
const strReplace = String.prototype.replace;
const strTrim = String.prototype.trim;
const strSlice = String.prototype.slice;
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
// The trader's own items (defect C13: sales, relists and expiries were
// never seen). Every one of these paths is an assumption until the market
// opens (docs/06-extension.md, day-one checklist), and all of them sit
// behind the same https + EA host check as the market. `/tradepile` is
// expected to carry a list of auctions: a successful answer that does not
// is reported as a trade-pile shape change (which stops nothing), an error
// answer as an EA error. The item-move and relist responses may well carry
// no auction at all, so for those an unreadable body is only logged.
// Deliberately NOT `/watchlist` or `/trade/status`: those
// show auctions the trader bid on or bought, and a won auction reads as
// `closed` at the price paid, which is a purchase, not a sale.
const PILE_PATH = /\/ut\/game\/[^/]+\/(tradepile|auctionhouse\/relist|item)\/?$/i;
const FULL_PILE_PATH = /\/tradepile\/?$/i;
// A buy or a bid (both are EA's bid on a trade): read only for the coin
// balance its answer states (`noteCredits`), never for anything else.
const BID_PATH = /\/ut\/game\/[^/]+\/trade\/\d+\/bid\/?$/i;

const stats = { seen: 0, parsed: 0, failed: 0 };

function post(kind: 'ready', data: { channel: string }): void;
function post(kind: 'probe', data: { ok: boolean; checkedAt: number; reason?: string; shape?: ShapeName; actReady: boolean }): void;
function post(kind: 'shape', data: { seen: number; parsed: number; failed: number; reason: string; endpoint: 'market' | 'pile' }): void;
function post(kind: 'ea_error', data: { status: number; category: EaErrorCategory; endpoint: EaErrorEndpoint; seenAt: number }): void;
function post(kind: 'heartbeat', data: { at: number }): void;
function post(kind: 'listings_buyable', data: { tradeIds: string[] }): void;
function post(kind: 'tradepile', data: { url: string; seenAt: number; items: TradePileItem[]; full?: boolean }): void;
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
  action: 'search' | 'buy' | 'readResult' | 'diagnostics' | 'list' | 'pile' | 'bid' | 'watchlist' | 'move' | 'club' | 'owned' | 'fromClub' | 'clearSold' | 'relistAll' | 'unsold' | 'relist' | 'clearExpired';
  requestId: string;
  ok: boolean;
  requestedAt: number;
  completedAt: number;
  error?: string;
  stillListed?: boolean;
  diagnostics?: AdapterDiagnostics;
  /** A watch list read's auctions (Bid mode). */
  watched?: WatchedAuction[];
  /** The unsold cards on the transfer list (`unsold`). */
  unsold?: TradePileItem[];
  /** How many finished auctions `clearExpired` took off the watch list. */
  cleared?: number;
  /** Which of the cards asked about the club holds (`owned`). */
  owned?: number[];
  clubCards?: { resourceId: number; tradeId: string }[];
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

/** The coin balance an EA response stated (`credits`), for Nova AI's
 * wallet: EA's top bar is not always redrawn after the bot's own buys and
 * sales. Sent when it changes, signed like the catalog. */
let lastCredits: number | null = null;
function noteCredits(payload: unknown): void {
  // Only the automation builds have the Nova AI page that shows it.
  if (!LISTING_ENABLED) return;
  const credits = (payload as Record<string, unknown> | null)?.credits;
  if (!isInteger(credits) || (credits as number) < 0 || credits === lastCredits) return;
  lastCredits = credits as number;
  const s = signer;
  if (!s) return;
  const data = { credits: credits as number, seenAt: now() };
  s.sign(canonicalActMessage('credits', data)).then(
    (mac) => {
      try {
        window.postMessage({ channel: ADAPTER_CHANNEL, kind: 'credits', data, mac }, window.location.origin);
      } catch {
        /* a page that has torn down its origin is not our problem */
      }
    },
    () => undefined,
  );
}

/** What the last probe posted said (ok and shape, or the failure), so the
 * periodic recheck at the bottom posts again only when that changes. */
let lastPostedProbe: string | null = null;
function probeKey(result: ProbeResult): string {
  return result.ok ? `ok:${result.shape}` : `failed:${result.reason}`;
}

function runProbeAndReport(): { result: ProbeResult; selection: ShapeSelection } {
  const outcome = probe();
  const result = outcome.result;
  // `actReady: false` means no nonce reached this adapter, so no act request
  // can ever be authenticated. Unsigned, so content treats it only as a
  // hint: a call that then times out is reported as adapter_unauthenticated
  // (not retried) rather than as a plain timeout (content/adapter-client.ts).
  post('probe', { ...result, checkedAt: Date.now(), actReady: signer !== null });
  lastPostedProbe = probeKey(result);
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
/** The card name for the panel and the assist confirm overlay: control
 * characters out, trimmed, at most 80 characters (`trimmedAuctionSchema`);
 * undefined when the item data carried none. */
function cardName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = apply(strTrim, apply(strReplace, name, [/[\u0000-\u001f\u007f]/g, '']), []) as string;
  const bounded = apply(strTrim, apply(strSlice, cleaned, [0, 80]), []) as string;
  return bounded ? bounded : undefined;
}

function trimAuction(a: NormalisedListing, seenAt: number): TrimmedAuction {
  const name = cardName(a.name);
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
    // The card's own id: what links a buy to its later sale
    // (lib/trade-lifecycle.ts). An id, not account data.
    ...(a.itemId ? { itemId: a.itemId } : {}),
    // The card's name, for the panel (P0 Task 13). Card data, like the
    // rating: nothing about the account.
    ...(name ? { name } : {}),
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
/** The last trade-pile response, for the diagnostics report (keys and
 * types only ever leave: `describeKeys`). */
let lastPileResponse: { path: string; at: number; value: unknown } | null = null;

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
 * for its lifetime (a relist gets a new tradeId). Bounded: past the cap the
 * listing sighted longest ago goes (`setNewest`). It used to start over,
 * which wiped the current search's listings along with the stale ones and
 * turned its buys into `listing_unknown` refusals. Read and written only
 * through the captured Map methods.
 */
interface SeenListing {
  buyNow: number;
  /** The card, as EA's own responses said: a buy that names a resourceId
   * must be one of these (`priceCheck`), and likewise an assetId. Every id
   * any sighting gave is kept, not just the latest: one search reaches the
   * adapter twice (its act result's item entity, and the network response
   * it caused, see `isSecondSighting`), the two can name the card by
   * different ids, and content was told only one of them. Keeping only the
   * latest refused real buys of the right card (`resource_mismatch`). */
  resourceIds: number[];
  assetIds: number[];
  expiresAt: number | null;
  /** The auction's starting and current bid as last seen: what a bid is
   * checked against (`bidCheck`). */
  startingBid: number;
  currentBid: number;
  /** The item entity an act search returned for this listing, for shapes
   * that buy on the entity. Absent for a listing only seen passively. */
  entity?: unknown;
}
const MAX_REMEMBERED_LISTINGS = 5000;
const lastSeenListings = new Map<string, SeenListing>();

/** Puts `key` in `map` as its newest entry (a Map keeps insertion order,
 * so a key seen again moves to the back), then drops the oldest entry once
 * there are more than `max`: the least recently seen goes first, never the
 * whole map. */
function setNewest<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  apply(mapDelete, map, [key]);
  apply(mapSet, map, [key, value]);
  if ((apply(mapSize, map, []) as number) <= max) return;
  const oldest = apply(mapIteratorNext, apply(mapKeys, map, []), []) as IteratorResult<string>;
  if (!oldest.done) apply(mapDelete, map, [oldest.value]);
}

function rememberListing(a: TrimmedAuction, entity: unknown): SeenListing {
  const previous = apply(mapGet, lastSeenListings, [a.tradeId]) as SeenListing | undefined;
  // A passive sighting after an act search keeps the entity, and the card
  // ids it gave: it is still the same listing (a relist gets a new tradeId).
  const keep = entity ?? previous?.entity;
  const resourceIds = withId(previous?.resourceIds, a.resourceId);
  const assetIds = withId(previous?.assetIds, a.assetId);
  const bids = { startingBid: a.startingBid, currentBid: a.currentBid };
  const seen: SeenListing =
    keep === undefined
      ? { buyNow: a.buyNow, resourceIds, assetIds, expiresAt: a.expiresAt, ...bids }
      : { buyNow: a.buyNow, resourceIds, assetIds, expiresAt: a.expiresAt, ...bids, entity: keep };
  setNewest(lastSeenListings, a.tradeId, seen, MAX_REMEMBERED_LISTINGS);
  return seen;
}

/** `ids` plus `id`, once. Plain loops, not Array methods the page could
 * have replaced. */
function withId(ids: readonly number[] | undefined, id: number): number[] {
  const out: number[] = [];
  if (ids) for (let i = 0; i < ids.length; i++) out[out.length] = ids[i]!;
  if (!hasId(out, id)) out[out.length] = id;
  return out;
}

function hasId(ids: readonly number[], id: number): boolean {
  for (let i = 0; i < ids.length; i++) if (ids[i] === id) return true;
  return false;
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

function handleBody(url: string, path: string, body: unknown, actIssued: boolean, status: number | null): void {
  if (typeof body !== 'string' || body.length === 0) {
    // EA answering with nothing is an EA error (the status, when it could
    // be read, was a success), not its payload changing shape.
    eaError('market', status ?? 0, path, 'empty answer');
    return;
  }

  let payload: unknown;
  try {
    payload = parseJson(body);
  } catch {
    shapeFailure('market', 'response was not JSON');
    return;
  }

  lastMarketResponse = { source: 'passive', at: now(), value: payload };
  noteCredits(payload);
  const auctionInfo = (payload as Record<string, unknown> | null)?.auctionInfo;
  if (!payload || !Array.isArray(auctionInfo)) {
    // EA's error envelope (`{ code, reason }`) under a success status is
    // still EA saying no.
    const envelope = errorEnvelopeStatus(payload);
    if (envelope !== null) return eaError('market', envelope, path, 'error envelope');
    // A market call with no auctionInfo is how a payload change first shows up.
    shapeFailure('market', 'no auctionInfo array in response');
    return;
  }

  let listings: NormalisedListing[];
  try {
    listings = normaliseListings(auctionInfo, skippedEntries('passive'));
  } catch (err) {
    // Entries there, none readable: the same payload change, one level down.
    shapeFailure('market', err instanceof Error ? err.message : String(err));
    return;
  }
  emitListings(String(url).split('?')[0] ?? url, listings, { kind: 'passive', actIssued });
}

/** The item list in a trade-pile answer, wherever its envelope keeps it:
 * `auctionInfo` (the trade pile, a relist), the `items` / `data.*`
 * envelopes search answers also come in (main/ea-response.ts), a bare
 * list, or `itemData` (an item move). `auctions`: whether it is a list of
 * auctions — only those can be a whole transfer list, never an item move's
 * `itemData`. All of them assumed envelopes (docs/06-extension.md). */
function pileList(payload: unknown): { list: unknown[]; auctions: boolean } | null {
  if (Array.isArray(payload)) return { list: payload, auctions: true };
  const r = payload as Record<string, unknown>;
  const data = r.data !== null && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : null;
  const auctionLists = [r.auctionInfo, data?.auctionInfo, r.items, data?.items];
  for (let i = 0; i < auctionLists.length; i++) if (Array.isArray(auctionLists[i])) return { list: auctionLists[i] as unknown[], auctions: true };
  if (Array.isArray(r.itemData)) return { list: r.itemData, auctions: false };
  if (data && Array.isArray(data.itemData)) return { list: data.itemData, auctions: false };
  return null;
}

/** A trade-pile response: its items go out as one `tradepile` message
 * (never `auctions`: this is not a search, and nothing is counted). What
 * it cannot read never stops anything: content reports a trade-pile shape
 * change, but no engine stops for it (it only feeds the transfer list
 * counts and the trade lifecycle). */
function handlePileBody(path: string, body: unknown, method: string, status: number | null): void {
  const whole = FULL_PILE_PATH.test(path);
  const failure = (reason: string): void => {
    if (whole) shapeFailure('pile', `trade pile: ${reason}`);
    else adapterLog.add(`passive: trade pile ${shortPath(path)}: ${reason}`);
  };
  if (typeof body !== 'string' || body.length === 0) {
    // The trade pile answering with nothing is EA's error, not a new shape.
    // A relist or an item move may well answer with nothing at all.
    if (whole) return eaError('pile', status ?? 0, path, 'empty answer');
    return failure('empty answer');
  }
  let payload: unknown;
  try {
    payload = parseJson(body);
  } catch {
    payload = undefined;
  }
  if (payload === null || typeof payload !== 'object') return failure('response was not a JSON object');
  lastPileResponse = { path, at: now(), value: payload };
  noteCredits(payload);
  const found = pileList(payload);
  if (!found) {
    const envelope = errorEnvelopeStatus(payload);
    if (envelope !== null) return eaError('pile', envelope, path, 'error envelope');
    // Key names only (never values), so the next report says what came instead.
    const keys = Object.keys(payload).slice(0, 12).join(', ') || 'none';
    return failure(`no auctionInfo / itemData list in response (keys: ${keys})`);
  }
  let items: TradePileItem[];
  let skipped = 0;
  const logSkipped = skippedEntries('trade pile');
  try {
    items = normalisePileItems(found.list, (count) => {
      skipped = count;
      logSkipped(count);
    });
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
  // A plain GET of the trade pile is plausibly the whole transfer list:
  // the lifecycle may then retire followed items missing from it. Any
  // other method, path or envelope is a partial view. Sent even when
  // empty, since an empty full pile is news too.
  // And only when every entry was read: an unreadable one might be a
  // followed card, which would then be wrongly retired.
  const full = whole && method.toUpperCase() === 'GET' && found.auctions && skipped === 0;
  if (items.length > 0 || full) post('tradepile', { url: path, seenAt: now(), items, full });
}

/** A 2xx EA answer whose JSON really changed shape. */
function shapeFailure(endpoint: 'market' | 'pile', reason: string): void {
  stats.failed++;
  adapterLog.add(`passive: ${reason}`);
  post('shape', { ...stats, reason, endpoint });
}

/** The last EA error line written to the adapter's log: a run of the same
 * error (EA rate limiting every search) is logged once, not 50 times over
 * everything else in the 50-line log. */
let lastEaErrorLine = '';

/** An EA error on a response the page itself received: any status outside
 * 2xx, EA's error envelope, or an answer with nothing in it. Posted as
 * `ea_error` with what kind of error it is (`eaErrorCategory`, in
 * packages/shared/src/adapter-channel.ts), never as a shape change: EA
 * saying no (an expired session, a captcha, too many requests, an outage)
 * is not its payload changing, and reporting it as one stopped the Sniping
 * Bot on the first error with a misleading "no auctionInfo" reason. */
function eaError(endpoint: 'market' | 'pile' | 'bid', status: number, path: string, note?: string): void {
  const category: EaErrorCategory = isOkStatus(status) ? 'other' : eaErrorCategory(status);
  const line = `passive: ${endpoint} ${shortPath(path)} answered HTTP ${status} (${category}${note ? `, ${note}` : ''})`;
  if (line !== lastEaErrorLine) {
    lastEaErrorLine = line;
    adapterLog.add(line);
  }
  post('ea_error', { status, category, endpoint, seenAt: now() });
}

/** A UTAS path without its `/ut/game/<title>` prefix, for log lines. */
function shortPath(path: string): string {
  return path.replace(/^.*\/ut\/game\/[^/]+/, '');
}

/** What an EA response is: the market, the trader's own trade pile, a buy
 * (read for its coin balance only), or nothing the adapter reads. Only
 * https on an EA host is ever any of them. */
function classify(url: unknown): 'market' | 'pile' | 'bid' | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URLCtor(url, window.location.href);
    if (parsed.protocol !== 'https:' || !EA_HOST.test(parsed.hostname)) return null;
    if (MARKET_PATH.test(parsed.pathname)) return 'market';
    if (PILE_PATH.test(parsed.pathname)) return 'pile';
    if (BID_PATH.test(parsed.pathname)) return 'bid';
    return null;
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URLCtor(url, window.location.href).pathname;
  } catch {
    return '';
  }
}

/** Route one response body the network really delivered. `status` is its
 * HTTP status, or null when it could not be read: then the body alone
 * decides, as before statuses were read. */
function handleResponse(kind: 'market' | 'pile' | 'bid', url: string, body: unknown, actIssued: boolean, method: string, status: number | null): void {
  const path = pathOf(url);
  // An error status is EA's error, whatever its body holds: never parsed
  // as a payload, and never a shape change.
  if (status !== null && !isOkStatus(status)) return eaError(kind, status, path);
  if (kind === 'market') handleBody(url, path, body, actIssued, status);
  else if (kind === 'pile') handlePileBody(path, body, method, status);
  else handleBidBody(body);
}

/** An HTTP status as read through a captured getter, or null. */
function statusOf(value: unknown): number | null {
  return typeof value === 'number' && isInteger(value) ? value : null;
}

/** A buy's answer: only its coin balance is read. */
function handleBidBody(body: unknown): void {
  try {
    if (typeof body === 'string' && body.length > 0) noteCredits(parseJson(body));
  } catch {
    /* not JSON: nothing to read */
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
const xhrStatus = protoGetter(proto, 'status');
function readXhr(getter: ((this: unknown) => unknown) | undefined, xhr: XMLHttpRequest): unknown {
  return getter ? apply(getter, xhr, []) : undefined;
}

proto.open = function (this: XMLHttpRequest & { __ledgerUrl?: string; __ledgerMethod?: string }, method: string, url: string | URL, ...rest: unknown[]) {
  try {
    this.__ledgerUrl = typeof url === 'string' ? url : String(url);
    this.__ledgerMethod = typeof method === 'string' ? method : 'GET';
  } catch {
    /* ignore */
  }
  // @ts-expect-error — forwarding the native overload's variadic tail as-is.
  return nativeOpen.call(this, method, url, ...rest);
};

proto.send = function (this: XMLHttpRequest & { __ledgerUrl?: string; __ledgerMethod?: string }, ...args: unknown[]) {
  try {
    const kind = classify(this.__ledgerUrl);
    if (kind) {
      if (kind === 'market') stats.seen++;
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
          if (xhrResponseURL && classify(finalUrl) !== kind) return;
          const url = this.__ledgerUrl as string;
          const method = this.__ledgerMethod ?? 'GET';
          const status = statusOf(readXhr(xhrStatus, this));
          const type = readXhr(xhrResponseType, this);
          if (type === '' || type === 'text') {
            handleResponse(kind, url, readXhr(xhrResponseText, this), actIssued, method, status);
          } else if (type === 'json') {
            // null: an empty (or unparseable) body, filed by its status.
            const json = readXhr(xhrResponse, this);
            handleResponse(kind, url, json == null ? '' : stringifyJson(json), actIssued, method, status);
          } else if (status !== null && !isOkStatus(status)) {
            eaError(kind, status, pathOf(url));
          } else if (kind === 'market') {
            shapeFailure('market', 'unreadable responseType: ' + type);
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
const responseStatus = protoGetter(ResponseProto, 'status');
const responseClone = ResponseProto?.clone;
const responseText = ResponseProto?.text;
if (typeof nativeFetch === 'function' && responseClone && responseText) {
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url = '';
    let method = 'GET';
    try {
      url = typeof input === 'string' ? input : input instanceof Request ? input.url : input instanceof URL ? input.toString() : '';
      method = typeof init?.method === 'string' ? init.method : input instanceof Request ? input.method : 'GET';
    } catch {
      /* ignore */
    }

    // Called and observed through captured `Reflect.apply` and
    // `Promise.prototype.then`, so a page script that later hooks
    // `Function.prototype.call` or `Promise.prototype.then` cannot slip a
    // Response of its own into what the adapter records. The page gets the
    // native promise back untouched.
    const promise = apply(nativeFetch, window, [input, init]) as Promise<Response>;
    const kind = classify(url);
    if (!kind) return promise;

    if (kind === 'market') stats.seen++;
    const actIssued = actSearchesInFlight > 0; // see the XHR patch above
    apply(promiseThen, promise, [
      (res: Response) => {
        try {
          // The final URL after redirects, read with the captured getter: a
          // market-looking request can still be answered from elsewhere, and
          // a Response built in script has no URL at all. Either way, not
          // recorded (fail closed).
          const finalUrl = responseUrl ? apply(responseUrl, res, []) : '';
          if (classify(finalUrl) !== kind) return;
          const status = statusOf(responseStatus ? apply(responseStatus, res, []) : undefined);
          const body = apply(responseText, apply(responseClone, res, []) as Response, []) as Promise<string>;
          apply(promiseThen, body, [
            (text: string) => handleResponse(kind, url, text, actIssued, method, status),
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

async function actSearch(requestId: string, filter: FilterCriteria, options: SearchOptions): Promise<void> {
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
      searched = await searchHook.unhooked(() => shape.search(services, filter, options));
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

/** The card a buy is for, when content names it. */
interface CardIds {
  resourceId?: number;
  assetId?: number;
}

/** Refuse unless the listing's buy-now price, as the adapter last saw it,
 * is exactly the price content expects to pay (see `lastSeenListings`), and,
 * when content names the card (`resourceId` / `assetId`), the listing is
 * that card. */
function priceCheck(tradeId: string, price: number, at: number, card: CardIds): string | null {
  const listing = apply(mapGet, lastSeenListings, [tradeId]) as SeenListing | undefined;
  if (!listing || (listing.expiresAt != null && listing.expiresAt <= at)) return ACT_ERROR.listingUnknown;
  if (card.resourceId !== undefined && !hasId(listing.resourceIds, card.resourceId)) return ACT_ERROR.resourceMismatch;
  if (card.assetId !== undefined && !hasId(listing.assetIds, card.assetId)) return ACT_ERROR.resourceMismatch;
  // buyNow 0 means the listing has no buy-now price: nothing to match.
  if (listing.buyNow <= 0 || listing.buyNow !== price) return ACT_ERROR.priceMismatch;
  return null;
}

async function actBuy(requestId: string, tradeId: string, price: number, card: CardIds): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('buy', requestId, requestedAt, result.reason);
  const refusal = priceCheck(tradeId, price, requestedAt, card);
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
        if (LISTING_ENABLED && bought) rememberBought(tradeId, entity);
        postResult({ action: 'buy', requestId, ok: bought, late: true, requestedAt, completedAt: now() });
      },
    });
    if (LISTING_ENABLED) rememberBought(tradeId, entity);
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

// ---- auto-sell (automation builds) ------------------------------------------

/** How long auto-sell lists a card for: one hour, the web app's shortest. */
const LIST_DURATION_SECONDS = 3600;
const MAX_BOUGHT_ITEMS = 500;
/** Items this adapter bought on this page load, by the tradeId they were
 * bought under: the only things `actList` will ever put on the market, so
 * no request, signed or not, can list anything else in the user's club. */
const boughtItems = new Map<string, unknown>();

function rememberBought(tradeId: string, entity: unknown): void {
  if (entity === undefined) return;
  // Past the cap the oldest buy goes, not every one still waiting to list.
  setNewest(boughtItems, tradeId, entity, MAX_BOUGHT_ITEMS);
}

async function actList(requestId: string, tradeId: string, startPrice: number, buyNowPrice: number): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('list', requestId, requestedAt, result.reason);
  if (!shape.list) return fail('list', requestId, requestedAt, 'list_unsupported');
  const entity = apply(mapGet, boughtItems, [tradeId]);
  if (entity === undefined) return fail('list', requestId, requestedAt, 'list_not_bought');
  try {
    await shape.list(servicesRoot() as Record<string, unknown>, {
      entity,
      startPrice,
      buyNowPrice,
      durationSeconds: LIST_DURATION_SECONDS,
    });
    apply(mapDelete, boughtItems, [tradeId]);
    adapterLog.add(`list ok (${shape.name})`);
    postResult({ action: 'list', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    fail('list', requestId, requestedAt, errorText(err), describeError(err));
  }
}

/** The shortest gap between two transfer-list reloads `actRefreshPile`
 * asks EA for, whatever content sends: they are real requests to EA. */
const PILE_REFRESH_MIN_GAP_MS = 15_000;
let lastPileRefreshAt = -Infinity;

/** Has the web app reload the transfer list through its own service (Nova
 * AI's Sold / Unsold / Transfer list counts). Its GET of the trade pile is
 * read by passive observation like any other (`handlePileBody`), so this
 * replies only whether EA answered. */
async function actRefreshPile(requestId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('pile', requestId, requestedAt, result.reason);
  if (!shape.refreshPile) return fail('pile', requestId, requestedAt, 'pile_unsupported');
  if (requestedAt - lastPileRefreshAt < PILE_REFRESH_MIN_GAP_MS) return fail('pile', requestId, requestedAt, 'pile_too_soon');
  lastPileRefreshAt = requestedAt;
  try {
    await shape.refreshPile(servicesRoot() as Record<string, unknown>);
    adapterLog.add(`pile refresh ok (${shape.name})`);
    postResult({ action: 'pile', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    fail('pile', requestId, requestedAt, errorText(err), describeError(err));
  }
}

// ---- the transfer list tools (automation builds) ----------------------------
//
// The Nova AI page's Transfer list card: Clear sold, and Relist unsold at
// the same prices (EA's own Re-list All) or a price step lower or higher
// (each card listed again, one act per card, paced by content).

/** The unsold cards the last `actUnsold` read, by EA's itemId, with their
 * entities: the only cards `actRelist` will put back on the market. A card
 * leaves once relisted. */
const MAX_UNSOLD_ITEMS = 100;
const unsoldItems = new Map<string, unknown>();

/** After a clear or a relist, the web app reloads the transfer list so the
 * page's counts show it (its GET reaches content passively, like any). The
 * result has already gone out: a reload that fails changes nothing EA did. */
async function reloadPileAfter(shape: ServiceShape): Promise<void> {
  if (!shape.refreshPile) return;
  lastPileRefreshAt = now();
  try {
    await shape.refreshPile(servicesRoot() as Record<string, unknown>);
  } catch (err) {
    adapterLog.add(`pile reload failed: ${describeError(err)}`);
  }
}

async function actClearSold(requestId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('clearSold', requestId, requestedAt, result.reason);
  if (!shape.clearSold) return fail('clearSold', requestId, requestedAt, 'clear_unsupported');
  try {
    await shape.clearSold(servicesRoot() as Record<string, unknown>);
  } catch (err) {
    return fail('clearSold', requestId, requestedAt, errorText(err), describeError(err));
  }
  adapterLog.add(`clear sold ok (${shape.name})`);
  postResult({ action: 'clearSold', requestId, ok: true, requestedAt, completedAt: now() });
  await reloadPileAfter(shape);
}

async function actRelistAll(requestId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('relistAll', requestId, requestedAt, result.reason);
  if (!shape.relistAll) return fail('relistAll', requestId, requestedAt, 'relist_unsupported');
  try {
    await shape.relistAll(servicesRoot() as Record<string, unknown>);
  } catch (err) {
    return fail('relistAll', requestId, requestedAt, errorText(err), describeError(err));
  }
  // Every card it held is listed again, under a new trade.
  apply(mapClear, unsoldItems, []);
  adapterLog.add(`relist all ok (${shape.name})`);
  postResult({ action: 'relistAll', requestId, ok: true, requestedAt, completedAt: now() });
  await reloadPileAfter(shape);
}

/** Reads the transfer list through the web app's own service and answers
 * with its unsold (expired) cards, keeping their entities for `actRelist`.
 * The read is a reload of the list, so the page's counts follow it too. It
 * leaves `actRefreshPile`'s gap alone: the reload content asks for once the
 * cards are relisted must not be refused for it. */
async function actUnsold(requestId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('unsold', requestId, requestedAt, result.reason);
  if (!shape.readPile || !shape.list) return fail('unsold', requestId, requestedAt, 'relist_unsupported');
  try {
    const entries = await shape.readPile(servicesRoot() as Record<string, unknown>);
    apply(mapClear, unsoldItems, []);
    const unsold: TradePileItem[] = [];
    for (let i = 0; i < entries.length && unsold.length < MAX_UNSOLD_ITEMS; i++) {
      const item = normalisePileItem(entries[i]);
      if (!item || item.tradeState !== 'expired') continue;
      unsold[unsold.length] = item;
      apply(mapSet, unsoldItems, [item.itemId, entries[i]]);
    }
    adapterLog.add(`unsold read ok (${shape.name}): ${unsold.length} of ${entries.length} cards`);
    postResult({ action: 'unsold', requestId, ok: true, requestedAt, completedAt: now(), unsold });
  } catch (err) {
    fail('unsold', requestId, requestedAt, errorText(err), describeError(err));
  }
}

/** Lists one unsold card the last `actUnsold` read (by its itemId) again,
 * at the prices content chose. Anything else is refused. */
async function actRelist(requestId: string, itemId: string, startPrice: number, buyNowPrice: number): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('relist', requestId, requestedAt, result.reason);
  if (!shape.list) return fail('relist', requestId, requestedAt, 'relist_unsupported');
  const entity = apply(mapGet, unsoldItems, [itemId]);
  if (entity === undefined) return fail('relist', requestId, requestedAt, 'relist_not_unsold');
  try {
    await shape.list(servicesRoot() as Record<string, unknown>, { entity, startPrice, buyNowPrice, durationSeconds: LIST_DURATION_SECONDS });
    apply(mapDelete, unsoldItems, [itemId]);
    adapterLog.add(`relist ok (${shape.name})`);
    postResult({ action: 'relist', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    fail('relist', requestId, requestedAt, errorText(err), describeError(err));
  }
}

// ---- Bid mode (automation builds) -------------------------------------------
//
// Nova AI's Bid mode bids on auctions in their last minutes, follows them on
// the watch list (EA's Transfer Targets, where every bid lands), and moves
// what it won to the transfer list. All through the web app's own calls
// (main/shapes.ts, `bidding`: ASSUMED SHAPE, verify on day one), like every
// other act.

/** Auctions this adapter bid on during this page load. Only one of these,
 * read as won on the watch list, ever becomes a card `actList` / `actMove`
 * will touch (`boughtItems`). Past the cap the oldest goes. */
const MAX_BID_ON = 500;
const bidOn = new Map<string, true>();

/** A watch list holds about 50 auctions; more than this is not one. */
const MAX_WATCHED = 100;
/** The finished auctions the last watch list read saw that the trader did
 * not win (expired, or ended with someone else's bid), with their
 * entities: the only items `actClearExpired` takes off the watch list. A
 * won auction, or one still running, is never in it. */
const finishedWatched = new Map<string, unknown>();
/** The shortest gap between two watch list reads, whatever content sends:
 * they are real requests to EA. Content asks far less often. */
const WATCHLIST_MIN_GAP_MS = 5_000;
let lastWatchlistAt = -Infinity;

/** Refuse unless `amount` is exactly the next valid bid on the auction as
 * the adapter last saw it in one of EA's own answers (a search or a watch
 * list read: `nextBidPrice`), under its buy-now price, and, when content
 * names the card, on that card. An `auctions` message, which any page
 * script can post, can make content believe anything about an auction; it
 * cannot change what the adapter bids. */
function bidCheck(tradeId: string, amount: number, at: number, card: CardIds): string | null {
  const listing = apply(mapGet, lastSeenListings, [tradeId]) as SeenListing | undefined;
  if (!listing || (listing.expiresAt != null && listing.expiresAt <= at)) return ACT_ERROR.listingUnknown;
  if (card.resourceId !== undefined && !hasId(listing.resourceIds, card.resourceId)) return ACT_ERROR.resourceMismatch;
  if (card.assetId !== undefined && !hasId(listing.assetIds, card.assetId)) return ACT_ERROR.resourceMismatch;
  if (amount !== nextBidPrice(listing.startingBid, listing.currentBid)) return ACT_ERROR.priceMismatch;
  // At the buy-now price or over it, it is a buy: that goes through `actBuy`.
  if (listing.buyNow > 0 && amount >= listing.buyNow) return ACT_ERROR.priceMismatch;
  return null;
}

/** The selected shape's Bid mode calls, or why there are none. */
function biddingOf(shape: ServiceShape): { bidding: NonNullable<ServiceShape['bidding']> } | { missing: string } {
  const bidding = shape.bidding;
  if (!bidding) return { missing: `the ${shape.name} shape has no bid calls` };
  const missing = bidding.detect(servicesRoot());
  return missing === null ? { bidding } : { missing };
}

async function actBid(requestId: string, tradeId: string, amount: number, card: CardIds): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('bid', requestId, requestedAt, result.reason);
  const calls = biddingOf(shape);
  if ('missing' in calls) return fail('bid', requestId, requestedAt, ACT_ERROR.biddingUnsupported, `${ACT_ERROR.biddingUnsupported}: ${calls.missing}`);
  const refusal = bidCheck(tradeId, amount, requestedAt, card);
  if (refusal) return fail('bid', requestId, requestedAt, refusal);
  const seen = apply(mapGet, lastSeenListings, [tradeId]) as SeenListing;
  if (shape.buysOnEntity && seen.entity === undefined) return fail('bid', requestId, requestedAt, ACT_ERROR.listingEntityUnknown);
  // Kept before the call: a bid EA takes but answers too late for is still
  // this adapter's own.
  setNewest(bidOn, tradeId, true, MAX_BID_ON);
  try {
    await calls.bidding.bid(servicesRoot() as Record<string, unknown>, { tradeId, amount, entity: seen.entity });
    // The bid is the auction's current one now: the same amount again is
    // refused here, as EA would refuse it.
    setNewest(lastSeenListings, tradeId, { ...seen, currentBid: amount }, MAX_REMEMBERED_LISTINGS);
    adapterLog.add(`bid ok (${shape.name})`);
    postResult({ action: 'bid', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    // The bid may still have gone through: the next watch list read says.
    if (err instanceof TimeoutUnknownError) return fail('bid', requestId, requestedAt, ACT_ERROR.timeoutUnknown, `${ACT_ERROR.timeoutUnknown}: ${err.message}`);
    fail('bid', requestId, requestedAt, errorText(err), describeError(err));
  }
}

/** Keeps what a watch list read said about an auction, for the next bid's
 * check (`bidCheck`), with its entity when the shape bids on one. */
function rememberWatched(w: WatchedAuction, entity: unknown, seenAt: number): void {
  const previous = apply(mapGet, lastSeenListings, [w.tradeId]) as SeenListing | undefined;
  const keep = entity ?? previous?.entity;
  const seen: SeenListing = {
    buyNow: w.buyNowPrice,
    resourceIds: withId(previous?.resourceIds, w.resourceId),
    assetIds: withId(previous?.assetIds, w.assetId),
    expiresAt: w.expires != null ? seenAt + w.expires * 1000 : null,
    startingBid: w.startingBid,
    currentBid: w.currentBid,
  };
  if (keep !== undefined) seen.entity = keep;
  setNewest(lastSeenListings, w.tradeId, seen, MAX_REMEMBERED_LISTINGS);
}

/** Reads the watch list through the web app's own service and sends it
 * back in the (signed) result. Every auction on it refreshes what the
 * adapter knows about it; one this adapter bid on that EA says it won
 * (`closed`, the trader's bid `highest`) becomes a card it may list or
 * move, like a card it bought. Never reported to the trade lifecycle: a
 * won auction reads `closed` at the price paid, which is a purchase. */
async function actWatchlist(requestId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('watchlist', requestId, requestedAt, result.reason);
  const calls = biddingOf(shape);
  if ('missing' in calls)
    return fail('watchlist', requestId, requestedAt, ACT_ERROR.biddingUnsupported, `${ACT_ERROR.biddingUnsupported}: ${calls.missing}`);
  if (requestedAt - lastWatchlistAt < WATCHLIST_MIN_GAP_MS) return fail('watchlist', requestId, requestedAt, 'watchlist_too_soon');
  lastWatchlistAt = requestedAt;
  try {
    const { response, entries } = await calls.bidding.readWatchlist(servicesRoot() as Record<string, unknown>);
    // For the diagnostics report's key names and types (day-one checklist).
    lastMarketResponse = { source: 'act:watchlist', at: now(), value: response };
    const watched = normaliseWatchedItems(entries, skippedEntries('watchlist'));
    const entities = new Map<string, unknown>();
    if (shape.buysOnEntity) {
      for (let i = 0; i < entries.length; i++) {
        const tradeId = normaliseWatchedItem(entries[i])?.tradeId;
        if (tradeId) apply(mapSet, entities, [tradeId, entries[i]]);
      }
    }
    const seenAt = now();
    const out: WatchedAuction[] = [];
    apply(mapClear, finishedWatched, []);
    for (let i = 0; i < watched.length && out.length < MAX_WATCHED; i++) {
      const w = watched[i]!;
      out[out.length] = w;
      const entity = apply(mapGet, entities, [w.tradeId]);
      rememberWatched(w, entity, seenAt);
      const lostOrExpired = w.tradeState === 'expired' || (w.tradeState === 'closed' && w.bidState !== 'highest');
      if (lostOrExpired && entity !== undefined) apply(mapSet, finishedWatched, [w.tradeId, entity]);
      if (w.tradeState === 'closed' && w.bidState === 'highest' && apply(mapGet, bidOn, [w.tradeId]) === true) rememberBought(w.tradeId, entity);
    }
    adapterLog.add(`watchlist ok (${shape.name}): ${out.length} auctions`);
    postResult({ action: 'watchlist', requestId, ok: true, requestedAt, completedAt: now(), watched: out });
  } catch (err) {
    fail('watchlist', requestId, requestedAt, errorText(err), describeError(err));
  }
}

/** Moves an auction this adapter won (by its tradeId) to the transfer list.
 * The card stays one it may list (`boughtItems`). */
async function actMove(requestId: string, tradeId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('move', requestId, requestedAt, result.reason);
  const move = shape.bidding?.moveToTransferList;
  if (!move) return fail('move', requestId, requestedAt, 'move_unsupported');
  const entity = apply(mapGet, boughtItems, [tradeId]);
  if (entity === undefined) return fail('move', requestId, requestedAt, 'move_not_bought');
  try {
    await apply(move, shape.bidding, [servicesRoot() as Record<string, unknown>, entity]);
    adapterLog.add(`move ok (${shape.name})`);
    postResult({ action: 'move', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    fail('move', requestId, requestedAt, errorText(err), describeError(err));
  }
}

/** Sends a card this adapter bought (by its tradeId) to the club, as the
 * web app's "Send to My Club" does (Gallery mode). The card stays one it
 * may move to the transfer list and list (`boughtItems`). */
async function actClub(requestId: string, tradeId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('club', requestId, requestedAt, result.reason);
  const club = shape.bidding?.moveToClub;
  if (!club) return fail('club', requestId, requestedAt, 'club_unsupported');
  const entity = apply(mapGet, boughtItems, [tradeId]);
  if (entity === undefined) return fail('club', requestId, requestedAt, 'club_not_bought');
  try {
    await apply(club, shape.bidding, [servicesRoot() as Record<string, unknown>, entity]);
    adapterLog.add(`club ok (${shape.name})`);
    postResult({ action: 'club', requestId, ok: true, requestedAt, completedAt: now() });
  } catch (err) {
    fail('club', requestId, requestedAt, errorText(err), describeError(err));
  }
}

/** Least time between two club reads (`owned`): Gallery mode asks once a
 * run, and once when the trader adds Sets. */
const OWNED_MIN_GAP_MS = 5_000;
let lastOwnedAt = -Infinity;

/** Which of these cards (EA's card ids) the club holds, through the web
 * app's own club search (Gallery mode). Read only. */
async function actOwned(requestId: string, resourceIds: number[]): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('owned', requestId, requestedAt, result.reason);
  const read = shape.bidding?.clubOwned;
  if (!read) return fail('owned', requestId, requestedAt, 'owned_unsupported');
  if (requestedAt - lastOwnedAt < OWNED_MIN_GAP_MS) return fail('owned', requestId, requestedAt, 'owned_too_soon');
  lastOwnedAt = requestedAt;
  try {
    const owned = await apply(read, shape.bidding, [servicesRoot() as Record<string, unknown>, resourceIds]);
    adapterLog.add(`owned ok (${shape.name}): ${owned.length} of ${resourceIds.length} in the club`);
    postResult({ action: 'owned', requestId, ok: true, requestedAt, completedAt: now(), owned });
  } catch (err) {
    fail('owned', requestId, requestedAt, errorText(err), describeError(err));
  }
}

/** Least time between two reads of the club's copies (`fromClub`): Gallery
 * mode asks once a run, and once when the trader presses Relist from club. */
const FROM_CLUB_MIN_GAP_MS = 5_000;
let lastFromClubAt = -Infinity;
/** The key a club copy is kept under in `boughtItems`: EA's item id behind
 * a prefix no tradeId carries, so a Gallery job can never name a bought
 * card and a club copy with the same number. */
const CLUB_KEY_PREFIX = 'club:';

/** The club's tradeable copies of these cards (EA's card ids), through the
 * web app's own club search (Gallery mode's stuck cards: sent to the club,
 * then not moved on because the transfer list was full). Each copy is kept
 * as a card `actMove` and `actList` may take to the market (`boughtItems`),
 * under the key the result names: nothing else in the club is ever
 * reachable, and only the content script names which card ids. */
async function actFromClub(requestId: string, resourceIds: number[]): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('fromClub', requestId, requestedAt, result.reason);
  const read = shape.bidding?.clubItems;
  if (!read || !shape.bidding?.moveToTransferList || !shape.list) return fail('fromClub', requestId, requestedAt, 'from_club_unsupported');
  if (requestedAt - lastFromClubAt < FROM_CLUB_MIN_GAP_MS) return fail('fromClub', requestId, requestedAt, 'from_club_too_soon');
  lastFromClubAt = requestedAt;
  try {
    const items = await apply(read, shape.bidding, [servicesRoot() as Record<string, unknown>, resourceIds]);
    const clubCards: { resourceId: number; tradeId: string }[] = [];
    for (let i = 0; i < items.length && clubCards.length < 100; i++) {
      const item = items[i]!;
      const tradeId = `${CLUB_KEY_PREFIX}${item.itemId}`;
      if (tradeId.length > 40) continue;
      rememberBought(tradeId, item.entity);
      clubCards[clubCards.length] = { resourceId: item.resourceId, tradeId };
    }
    adapterLog.add(`from club ok (${shape.name}): ${clubCards.length} of ${resourceIds.length} cards in the club`);
    postResult({ action: 'fromClub', requestId, ok: true, requestedAt, completedAt: now(), clubCards });
  } catch (err) {
    fail('fromClub', requestId, requestedAt, errorText(err), describeError(err));
  }
}

/** Takes the finished auctions the last watch list read saw (expired, or
 * lost to another bid) off the watch list, as Transfer Targets' "Clear
 * expired" does. Never a won or running one (`finishedWatched`). */
async function actClearExpired(requestId: string): Promise<void> {
  const requestedAt = now();
  const { result, selection } = runProbeAndReport();
  const shape = selection.shape;
  if (!result.ok || !shape) return fail('clearExpired', requestId, requestedAt, result.reason);
  const untarget = shape.bidding?.untarget;
  if (!untarget) return fail('clearExpired', requestId, requestedAt, 'clear_expired_unsupported');
  const entities: unknown[] = [];
  for (const entity of finishedWatched.values()) entities[entities.length] = entity;
  if (entities.length === 0) return postResult({ action: 'clearExpired', requestId, ok: true, requestedAt, completedAt: now(), cleared: 0 });
  try {
    await apply(untarget, shape.bidding, [servicesRoot() as Record<string, unknown>, entities]);
    apply(mapClear, finishedWatched, []);
    adapterLog.add(`clear expired ok (${shape.name}): ${entities.length}`);
    postResult({ action: 'clearExpired', requestId, ok: true, requestedAt, completedAt: now(), cleared: entities.length });
  } catch (err) {
    fail('clearExpired', requestId, requestedAt, errorText(err), describeError(err));
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
    lastTradePileResponse: lastPileResponse
      ? { path: scrubText(lastPileResponse.path).slice(0, 200), at: lastPileResponse.at, shape: describeKeys(lastPileResponse.value, 6) }
      : null,
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
  | { action: 'search'; requestId: string; filter: FilterCriteria; maxBid?: number }
  | { action: 'buy'; requestId: string; tradeId: string; price: number; resourceId?: number; assetId?: number }
  | { action: 'bid'; requestId: string; tradeId: string; price: number; resourceId?: number; assetId?: number }
  | { action: 'readResult'; requestId: string; tradeId: string }
  | { action: 'list'; requestId: string; tradeId: string; startPrice: number; buyNowPrice: number }
  | { action: 'move'; requestId: string; tradeId: string }
  | { action: 'club'; requestId: string; tradeId: string }
  | { action: 'owned'; requestId: string; resourceIds: number[] }
  | { action: 'fromClub'; requestId: string; resourceIds: number[] }
  | { action: 'diagnostics'; requestId: string }
  | { action: 'catalog'; requestId: string }
  | { action: 'pile'; requestId: string }
  | { action: 'watchlist'; requestId: string }
  | { action: 'clearSold'; requestId: string }
  | { action: 'relistAll'; requestId: string }
  | { action: 'unsold'; requestId: string }
  | { action: 'clearExpired'; requestId: string }
  | { action: 'relist'; requestId: string; itemId: string; startPrice: number; buyNowPrice: number };

/** EA's listing limits, with the starting bid below the buy-now price. */
function isListingPrice(start: unknown, bin: unknown): boolean {
  return isInteger(start) && isInteger(bin) && (start as number) >= 150 && (bin as number) >= 200 && (bin as number) <= 15_000_000 && (start as number) < (bin as number);
}

/** A whole coin amount within EA's bid limits (150 to 15,000,000). */
function isBidAmount(value: unknown): boolean {
  return isInteger(value) && (value as number) >= 150 && (value as number) <= 15_000_000;
}

// Keep in sync with `adapterActRequestMessageSchema` (packages/shared/src/
// ext-messages.ts): this file stays zod-free, so it re-checks the same shape
// by hand.
function asActRequest(value: unknown): ActRequest | null {
  const d = value as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || typeof d.requestId !== 'string' || d.requestId === '') return null;
  if (d.action === 'search') {
    if (!d.filter || typeof d.filter !== 'object') return null;
    return d.maxBid === undefined || isBidAmount(d.maxBid) ? (d as unknown as ActRequest) : null;
  }
  if (
    d.action === 'diagnostics' ||
    d.action === 'catalog' ||
    d.action === 'pile' ||
    d.action === 'watchlist' ||
    d.action === 'clearSold' ||
    d.action === 'relistAll' ||
    d.action === 'unsold' ||
    d.action === 'clearExpired'
  )
    return d as unknown as ActRequest;
  if (d.action === 'owned' || d.action === 'fromClub') {
    const ids = d.resourceIds;
    if (!isArray(ids) || ids.length === 0 || ids.length > 100) return null;
    for (let i = 0; i < ids.length; i++) if (!isInteger(ids[i]) || (ids[i] as number) <= 0) return null;
    return d as unknown as ActRequest;
  }
  if (d.action === 'relist') {
    if (typeof d.itemId !== 'string' || d.itemId === '' || d.itemId.length > 40) return null;
    return isListingPrice(d.startPrice, d.buyNowPrice) ? (d as unknown as ActRequest) : null;
  }
  if (typeof d.tradeId !== 'string' || d.tradeId === '') return null;
  if (d.action === 'readResult' || d.action === 'move' || d.action === 'club') return d as unknown as ActRequest;
  if (d.action === 'bid') {
    if (!isBidAmount(d.price)) return null;
    for (const id of [d.resourceId, d.assetId]) if (id !== undefined && (!isInteger(id) || (id as number) <= 0)) return null;
    return d as unknown as ActRequest;
  }
  if (d.action === 'list') {
    return isListingPrice(d.startPrice, d.buyNowPrice) ? (d as unknown as ActRequest) : null;
  }
  if (d.action === 'buy') {
    if (!isInteger(d.price) || (d.price as number) <= 0) return null;
    for (const id of [d.resourceId, d.assetId]) if (id !== undefined && (!isInteger(id) || (id as number) <= 0)) return null;
    return d as unknown as ActRequest;
  }
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

  if (request.action === 'search') await actSearch(request.requestId, request.filter, request.maxBid === undefined ? {} : { maxBid: request.maxBid });
  else if (request.action === 'buy') await actBuy(request.requestId, request.tradeId, request.price, { resourceId: request.resourceId, assetId: request.assetId });
  else if (request.action === 'bid') {
    if (BIDDING_ENABLED) await actBid(request.requestId, request.tradeId, request.price, { resourceId: request.resourceId, assetId: request.assetId });
  }
  else if (request.action === 'watchlist') {
    if (BIDDING_ENABLED) await actWatchlist(request.requestId);
  }
  else if (request.action === 'move') {
    if (BIDDING_ENABLED) await actMove(request.requestId, request.tradeId);
  }
  else if (request.action === 'club') {
    if (BIDDING_ENABLED) await actClub(request.requestId, request.tradeId);
  }
  else if (request.action === 'owned') {
    if (BIDDING_ENABLED) await actOwned(request.requestId, request.resourceIds);
  }
  else if (request.action === 'fromClub') {
    if (BIDDING_ENABLED && LISTING_ENABLED) await actFromClub(request.requestId, request.resourceIds);
  }
  else if (request.action === 'clearExpired') {
    if (BIDDING_ENABLED) await actClearExpired(request.requestId);
  }
  else if (request.action === 'readResult') await actReadResult(request.requestId, request.tradeId);
  else if (request.action === 'list') {
    if (LISTING_ENABLED) await actList(request.requestId, request.tradeId, request.startPrice, request.buyNowPrice);
  }
  else if (request.action === 'pile') {
    if (LISTING_ENABLED) await actRefreshPile(request.requestId);
  }
  else if (request.action === 'clearSold') {
    if (LISTING_ENABLED) await actClearSold(request.requestId);
  }
  else if (request.action === 'relistAll') {
    if (LISTING_ENABLED) await actRelistAll(request.requestId);
  }
  else if (request.action === 'unsold') {
    if (LISTING_ENABLED) await actUnsold(request.requestId);
  }
  else if (request.action === 'relist') {
    if (LISTING_ENABLED) await actRelist(request.requestId, request.itemId, request.startPrice, request.buyNowPrice);
  }
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

// A userscript manager may inject this file after the web app's own scripts
// have started (lib/act-auth.ts's `isSafeToHandOff`). Nothing breaks: the
// probe below, and the recheck after it, pick the service layer up
// whenever it is (or becomes) there. Only the market calls made before now
// went unseen. Noted once, for the diagnostics report.
if (document.readyState !== 'loading' || servicesRoot() !== undefined) {
  adapterLog.add(`adapter started after the web app (document ${document.readyState}, services ${servicesRoot() === undefined ? 'not yet built' : 'already built'})`);
}

post('ready', { channel: ADAPTER_CHANNEL });
runProbeAndReport();

/** How often the adapter says it is alive (`heartbeat`, for content's
 * watchdog: content/watchdog.ts), whatever the page is doing. */
const HEARTBEAT_MS = 20_000;
let lastHeartbeatAt = -Infinity;
/** Set once the startup poll below has reported the probe. */
let startupProbeReported = false;
/** A failing outcome the recheck saw once and has not reported yet. */
let unconfirmedProbe: string | null = null;

// `window.services` appears some time after document_start, and the page
// may rebuild it; the probe installs the search hook whenever it runs, and
// this keeps checking between act calls so the human's first searches are
// seen too. A few property reads every couple of seconds.
setTimer(function recheck() {
  try {
    const { result } = probe();
    const key = probeKey(result);
    // Once the startup report is out, a probe whose outcome changed is
    // reported rather than left for the next act call: a service layer that
    // turned up late (a late injection, a slow login) reaches content at
    // once, and one that went away (a bundle swap) on the next recheck too —
    // a failure only when it is still failing then, so a page rebuilding
    // `window.services` never stops the bot.
    if (!startupProbeReported || key === lastPostedProbe) unconfirmedProbe = null;
    else if (result.ok || unconfirmedProbe === key) {
      unconfirmedProbe = null;
      runProbeAndReport();
    } else unconfirmedProbe = key;
  } catch {
    /* never break the page */
  }
  try {
    // By the clock, not by counting ticks: a background tab runs this
    // timer far less often than asked.
    const t = now();
    if (t - lastHeartbeatAt >= HEARTBEAT_MS) {
      lastHeartbeatAt = t;
      post('heartbeat', { at: t });
    }
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
