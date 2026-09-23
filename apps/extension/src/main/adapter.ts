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
 *      This file never constructs a UTAS request by hand.
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

import { LOC_FILE, PLAYERS_FILE, parseLocFile, parsePlayersFile, type CatalogNames, type CatalogPlayer } from '../model/catalog.js';

import type { AdapterActRequestMessage, FilterCriteria, TrimmedAuction } from '@sl/shared';

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

const stats = { seen: 0, parsed: 0, failed: 0 };

function post(kind: 'ready', data: { channel: string }): void;
function post(kind: 'probe', data: { ok: boolean; checkedAt: number; reason?: string }): void;
function post(kind: 'shape', data: { seen: number; parsed: number; failed: number; reason: string }): void;
function post(
  kind: 'auctions',
  data: { url: string; seenAt: number; auctions: TrimmedAuction[]; stats: { seen: number; parsed: number; failed: number } },
): void;
function post(
  kind: 'action_result',
  data: {
    action: 'search' | 'buy' | 'readResult';
    requestId?: string;
    ok: boolean;
    requestedAt: number;
    completedAt: number;
    error?: string;
    stillListed?: boolean;
  },
): void;
function post(kind: 'catalog', data: { players?: CatalogPlayer[]; names?: CatalogNames }): void;
function post(kind: string, data: unknown): void {
  try {
    window.postMessage({ channel: ADAPTER_CHANNEL, kind, data }, window.location.origin);
  } catch {
    /* a page that has torn down its origin is not our problem */
  }
}

function runProbeAndReport(): ProbeResult {
  const result = probe();
  post('probe', { ...result, checkedAt: Date.now() });
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
  const expiresIn = Number(a.expires);
  return {
    tradeId: String(a.tradeId),
    resourceId: Number(item.resourceId ?? item.assetId ?? 0),
    assetId: Number(item.assetId ?? 0),
    rating: Number(item.rating ?? 0),
    buyNow: Number(a.buyNowPrice ?? 0),
    startingBid: Number(a.startingBid ?? 0),
    currentBid: Number(a.currentBid ?? 0),
    offers: Number(a.offers ?? 0),
    // expires arrives as seconds remaining; an absolute time is what we can compare later
    expiresAt: Number.isFinite(expiresIn) ? seenAt + expiresIn * 1000 : null,
    seenAt,
  };
}

/** Trim + emit a raw `auctionInfo` array through the same 'auctions' message
 * passive observation uses, whether it came from a patched network response
 * or from `act.search()` driving `services.Item.repository.search`
 * directly — one pipeline, one privacy seam, regardless of source. */
function emitAuctionInfo(url: string, auctionInfo: unknown[]): TrimmedAuction[] {
  const seenAt = Date.now();
  const auctions: TrimmedAuction[] = [];
  for (const a of auctionInfo) {
    if (!a || typeof a !== 'object' || (a as Record<string, unknown>).tradeId == null) continue;
    const trimmed = trimAuction(a as Record<string, unknown>, seenAt);
    if (trimmed.resourceId > 0) auctions.push(trimmed);
  }
  stats.parsed++;
  post('auctions', { url, seenAt, auctions, stats: { ...stats } });
  return auctions;
}

function handleBody(url: string, body: unknown): void {
  if (typeof body !== 'string' || body.length === 0) {
    stats.failed++;
    post('shape', { ...stats, reason: 'empty body' });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
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
  return typeof url === 'string' && MARKET_PATH.test(url);
}

// ---- EA's own search data (model/catalog.ts) -------------------------------
//
// The web app downloads its player list and its localisation (club, league
// and nation names) for its own search form. Keeping a parsed copy is what
// lets the Snipe Targets form offer the same choices. Kept here too, because
// the web app may load them before the content script is listening: the
// content script asks for them again with an `act_request` of `catalog`.

let catalogPlayers: CatalogPlayer[] | null = null;
let catalogNames: CatalogNames | null = null;

function isCatalogFile(url: unknown): url is string {
  return typeof url === 'string' && (PLAYERS_FILE.test(url) || LOC_FILE.test(url));
}

function handleCatalogBody(url: string, body: unknown): void {
  let json: unknown;
  try {
    json = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return;
  }
  if (PLAYERS_FILE.test(url)) {
    const players = parsePlayersFile(json);
    if (players.length === 0) return;
    catalogPlayers = players;
    post('catalog', { players });
  } else {
    const names = parseLocFile(json);
    if (names.clubs.length + names.leagues.length + names.nations.length === 0) return;
    catalogNames = names;
    post('catalog', { names });
  }
}

function postCatalog(): void {
  if (catalogPlayers || catalogNames) {
    post('catalog', { ...(catalogPlayers ? { players: catalogPlayers } : {}), ...(catalogNames ? { names: catalogNames } : {}) });
  }
}

// ---- XMLHttpRequest --------------------------------------------------------
const proto = XMLHttpRequest.prototype;
const nativeOpen = proto.open;
const nativeSend = proto.send;

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
    if (isCatalogFile(this.__ledgerUrl)) {
      this.addEventListener('load', () => {
        try {
          const type = this.responseType;
          if (type === '' || type === 'text') handleCatalogBody(this.__ledgerUrl as string, this.responseText);
          else if (type === 'json') handleCatalogBody(this.__ledgerUrl as string, this.response);
        } catch {
          /* a catalog we cannot read just leaves the form asking for ids */
        }
      });
    }
    if (isMarket(this.__ledgerUrl)) {
      stats.seen++;
      this.addEventListener('load', () => {
        try {
          const type = this.responseType;
          if (type === '' || type === 'text') {
            handleBody(this.__ledgerUrl as string, this.responseText);
          } else if (type === 'json' && this.response) {
            handleBody(this.__ledgerUrl as string, JSON.stringify(this.response));
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
if (typeof nativeFetch === 'function') {
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof Request ? input.url : input instanceof URL ? input.toString() : '';
    } catch {
      /* ignore */
    }

    const promise = nativeFetch.call(window, input, init);
    if (isCatalogFile(url)) {
      return promise.then((res) => {
        try {
          res
            .clone()
            .text()
            .then(
              (body) => handleCatalogBody(url, body),
              () => undefined,
            );
        } catch {
          /* never break the app's own request */
        }
        return res;
      });
    }
    if (!isMarket(url)) return promise;

    stats.seen++;
    return promise.then((res) => {
      try {
        res
          .clone()
          .text()
          .then(
            (body) => handleBody(url, body),
            () => {
              stats.failed++;
            },
          );
      } catch {
        stats.failed++;
      }
      return res;
    });
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
  // Field names follow the web app's own search-criteria object
  // (UTSearchCriteriaDTO) as other FUT tools drive it: a player search is by
  // base definition id (`maskedDefId`, the id EA's players.json lists), and
  // quality is `level`. Rating is not a market search field: engine/sniper.ts
  // filters on it after the results come back.
  const criteria: Record<string, unknown> = { type: 'player' };
  if (filter.resourceId != null) criteria.maskedDefId = filter.resourceId;
  if (filter.minPrice != null) criteria.minBuy = filter.minPrice;
  if (filter.maxPrice != null) criteria.maxBuy = filter.maxPrice;
  if (filter.position != null) criteria.position = filter.position;
  if (filter.nationality != null) criteria.nation = filter.nationality;
  if (filter.league != null) criteria.league = filter.league;
  if (filter.club != null) criteria.club = filter.club;
  if (filter.quality != null) criteria.level = filter.quality === 'special' ? 'SP' : filter.quality;
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
    post('action_result', { action: 'search', requestId, ok: false, requestedAt, completedAt: Date.now(), error: probeResult.reason });
    return;
  }
  try {
    const services = assumedServices();
    const search = services?.Item?.repository?.search;
    if (typeof search !== 'function') throw new Error('services.Item.repository.search vanished after probe() passed');
    const criteria = mapFilterToSearchCriteria(filter);
    const result = await search(criteria);
    emitAuctionInfo('act:search', extractAuctionInfo(result));
    post('action_result', { action: 'search', requestId, ok: true, requestedAt, completedAt: Date.now() });
  } catch (err) {
    post('action_result', {
      action: 'search',
      requestId,
      ok: false,
      requestedAt,
      completedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function actBuy(requestId: string, tradeId: string): Promise<void> {
  const requestedAt = Date.now();
  const probeResult = runProbeAndReport();
  if (!probeResult.ok) {
    post('action_result', { action: 'buy', requestId, ok: false, requestedAt, completedAt: Date.now(), error: probeResult.reason });
    return;
  }
  try {
    const services = assumedServices();
    const buyNow = services?.Transfer?.repository?.buyNow;
    if (typeof buyNow !== 'function') throw new Error('services.Transfer.repository.buyNow vanished after probe() passed');
    const result = await buyNow(tradeId);
    const failed = !!result && typeof result === 'object' && (result as Record<string, unknown>).success === false;
    post('action_result', {
      action: 'buy',
      requestId,
      ok: !failed,
      requestedAt,
      completedAt: Date.now(),
      error: failed ? 'buyNow resolved with success: false' : undefined,
    });
  } catch (err) {
    post('action_result', {
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
    post('action_result', { action: 'readResult', requestId, ok: false, requestedAt, completedAt: Date.now(), error: probeResult.reason });
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
    post('action_result', { action: 'readResult', requestId, ok: true, requestedAt, completedAt: Date.now(), stillListed });
  } catch (err) {
    post('action_result', {
      action: 'readResult',
      requestId,
      ok: false,
      requestedAt,
      completedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const msg = event.data as { channel?: string; kind?: string; data?: unknown } | null;
  if (!msg || msg.channel !== ADAPTER_CHANNEL || msg.kind !== 'act_request') return;
  const data = msg.data as AdapterActRequestMessage['data'] | undefined;
  if (!data || typeof data.action !== 'string' || typeof data.requestId !== 'string') return;

  if (data.action === 'search') void actSearch(data.requestId, data.filter);
  else if (data.action === 'buy') void actBuy(data.requestId, data.tradeId);
  else if (data.action === 'readResult') void actReadResult(data.requestId, data.tradeId);
  else if (data.action === 'catalog') postCatalog();
});

post('ready', { channel: ADAPTER_CHANNEL });
runProbeAndReport();
