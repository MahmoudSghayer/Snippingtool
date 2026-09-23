/*
 * adapter.ts — the ONLY file that knows anything about EA's internals.
 *
 * Runs in the page's MAIN world (manifest: world "MAIN", document_start;
 * the userscript injects it at document-start) so it can see the web app's
 * own network calls and use its own service layer. Three jobs, all under the
 * same rule — only ever do what the app's own UI does, through the app's own
 * code; never touch the session token, never forge or replay a request:
 *
 *   1. Passive observation (M1): patch XMLHttpRequest and fetch to *read*
 *      market responses the app was already going to receive, trim them
 *      with `trimAuction`, and post them to the ISOLATED world.
 *   2. The `act` surface (M2/M3): `search` and `buy`, through the same
 *      service calls the app's own Transfer Market screens make.
 *   3. The catalog: the Snipe Targets form's choices, built with the app's
 *      own list and image helpers (model/catalog.ts).
 *
 * VERIFIED SHAPE (FC 27 web app, compiled_1-4.js / ocompiled.js,
 * 2026-09-23 — see docs/06-extension.md "Web app shape"):
 *
 *   services.Item.clearTransferMarketCache()
 *     The app calls this before opening search results; without it,
 *     `searchTransferMarket` answers from its page cache.
 *   services.Item.searchTransferMarket(criteria: UTSearchCriteriaDTO, page)
 *     -> EAObservable; `.observe(ctx, (obs, res) => ...)`, then
 *     `obs.unobserve(ctx)`. `res.success`, `res.data.items`: UTItemEntity[]
 *     (`definitionId`, `databaseId` = base player id, `rating`,
 *     `getAuctionData()` -> { tradeId, buyNowPrice, startingBid, currentBid,
 *     expires (seconds), ... }).
 *   services.Item.bid(item: UTItemEntity, amount) -> EAObservable, same
 *     observe pattern; `res.success`, `res.error.code`. Buying now is a bid
 *     of the buy-now price, exactly as the app's Buy Now button does it.
 *   new UTSearchCriteriaDTO(): set `type` FIRST (its setter resets nation,
 *     position, rarities and play style), then maskedDefId, level
 *     ('bronze'|'silver'|'gold'|'SP'), rarities [id], position ('ST'...) or
 *     zone (130/131/132), playStyle, nation, league, club, minBuy, maxBuy,
 *     ovrMin, ovrMax.
 *   new UTDataProviderFactory(services.Localization, repositories.Squad,
 *     repositories.TeamConfig) and AssetLocationUtils: see buildCatalog().
 *
 * If any of that is missing, `probe()` fails closed with a reason naming
 * what is missing, the engine hard-stops before acting, and the panel goes
 * amber. Nowhere else in the codebase knows EA's shape, by design
 * (docs/01-architecture.md, "never-forge-a-request seam").
 */
// `ADAPTER_CHANNEL` comes from the zod-free `adapter-channel.js` subpath, not
// the `@sl/shared` barrel — this file runs in the page's MAIN world on every
// matching load, so it deliberately avoids pulling `zod` and every schema in
// `ext-messages.ts` along with it just for one string constant (see
// packages/shared/src/adapter-channel.ts).
import { ADAPTER_CHANNEL } from '@sl/shared/adapter-channel.js';

import { buildStaticLists } from '../model/catalog-static.js';
import {
  POSITION_ZONES,
  parsePlayersFile,
  type Catalog,
  type CatalogOption,
} from '../model/catalog.js';

import type { AdapterActRequestMessage, FilterCriteria, TrimmedAuction } from '@sl/shared';

// ---- the web app's globals, as far as this file uses them -------------------

interface EaObservable<T> {
  observe(ctx: object, cb: (obs: EaObservable<T>, res: T) => void): void;
  unobserve(ctx: object): void;
}

interface EaAuction {
  tradeId: string | number;
  buyNowPrice: number;
  startingBid: number;
  currentBid: number;
  expires: number;
}

interface EaItem {
  definitionId: number;
  databaseId: number;
  rating: number;
  getAuctionData(): EaAuction | null | undefined;
}

interface EaResponse {
  success: boolean;
  status?: number;
  error?: { code?: string | number } | null;
  data?: { items?: EaItem[] };
}

interface EaDataEntry {
  id: number;
  value: unknown;
  label: string;
}

interface EaGlobals {
  services?: {
    Item?: {
      searchTransferMarket?: (criteria: object, page: number) => EaObservable<EaResponse>;
      bid?: (item: EaItem, amount: number) => EaObservable<EaResponse>;
      clearTransferMarketCache?: () => void;
    };
    Localization?: unknown;
  };
  repositories?: {
    Squad?: unknown;
    TeamConfig?: { getNations?: () => unknown[]; getLeagues?: () => { id: number }[] };
    Rarity?: { getRarity?: (id: number) => { levels?: boolean } | undefined };
  };
  UTSearchCriteriaDTO?: new () => Record<string, unknown>;
  UTDataProviderFactory?: new (
    loc: unknown,
    squad: unknown,
    teams: unknown,
  ) => Record<string, (...a: unknown[]) => EaDataEntry[]>;
  AssetLocationUtils?: {
    FILTER: Record<string, string>;
    getFilterImage(filter: string, value: unknown, extra?: unknown): string;
    getPlayerSearchFileUri(): string;
    getPortraitImageUri(id: number): string;
  };
  SearchType?: { PLAYER: string };
  ItemType?: { PLAYER: string };
  SearchLevel?: { ANY: string };
}

const ea = window as unknown as EaGlobals;

interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/** Verify the web app's shape still holds. Run before every `act` call —
 * never cached, because the point is to catch a bundle update mid-session. */
function probe(): ProbeResult {
  const item = ea.services?.Item;
  if (!item)
    return { ok: false, reason: 'services.Item is missing (web app not started, or changed)' };
  if (typeof item.searchTransferMarket !== 'function')
    return { ok: false, reason: 'services.Item.searchTransferMarket is not a function' };
  if (typeof item.bid !== 'function')
    return { ok: false, reason: 'services.Item.bid is not a function' };
  if (typeof ea.UTSearchCriteriaDTO !== 'function')
    return { ok: false, reason: 'UTSearchCriteriaDTO is not a constructor' };
  if (!ea.SearchType?.PLAYER) return { ok: false, reason: 'SearchType.PLAYER is missing' };
  return { ok: true };
}

// ---------------------------------------------------------------------------

// The UTAS market path has outlived many bundle rewrites: /ut/game/<title>/transfermarket
const MARKET_PATH = /\/ut\/game\/[^/]+\/transfermarket\b/i;

const stats = { seen: 0, parsed: 0, failed: 0 };

function post(kind: 'ready', data: { channel: string }): void;
function post(kind: 'probe', data: { ok: boolean; checkedAt: number; reason?: string }): void;
function post(
  kind: 'shape',
  data: { seen: number; parsed: number; failed: number; reason: string },
): void;
function post(
  kind: 'auctions',
  data: {
    url: string;
    seenAt: number;
    auctions: TrimmedAuction[];
    stats: { seen: number; parsed: number; failed: number };
  },
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
function post(kind: 'catalog', data: Catalog): void;
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

/** Trim + emit a raw `auctionInfo` array through the 'auctions' message:
 * everything passive observation reads from the market's network responses,
 * including the ones `act.search()` causes, goes through here. */
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

// ---- XMLHttpRequest --------------------------------------------------------
const proto = XMLHttpRequest.prototype;
const nativeOpen = proto.open;
const nativeSend = proto.send;

proto.open = function (
  this: XMLHttpRequest & { __ledgerUrl?: string },
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
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
      url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : '';
    } catch {
      /* ignore */
    }

    const promise = nativeFetch.call(window, input, init);
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

/** Search results by trade id: `services.Item.bid` takes the item itself. */
const searchedItems = new Map<string, EaItem>();
const MAX_REMEMBERED_ITEMS = 500;

/** Resolves once with the observable's first result. */
function once<T>(obs: EaObservable<T>, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const ctx = {};
    const timer = setTimeout(() => {
      obs.unobserve(ctx);
      reject(new Error('the web app did not answer in time'));
    }, timeoutMs);
    obs.observe(ctx, (o, res) => {
      clearTimeout(timer);
      o.unobserve(ctx);
      resolve(res);
    });
  });
}

/** `FilterCriteria` -> the web app's own `UTSearchCriteriaDTO`. */
function buildSearchCriteria(filter: FilterCriteria): Record<string, unknown> {
  const c = new ea.UTSearchCriteriaDTO!();
  c.type = ea.SearchType!.PLAYER; // first: its setter resets the fields below
  if (filter.resourceId != null) c.maskedDefId = filter.resourceId;
  if (filter.quality != null) c.level = filter.quality === 'special' ? 'SP' : filter.quality;
  if (filter.rarity != null) c.rarities = [filter.rarity];
  if (filter.zone != null) c.zone = filter.zone;
  else if (filter.position != null) c.position = filter.position;
  if (filter.chemistryStyle != null) c.playStyle = filter.chemistryStyle;
  if (filter.nationality != null) c.nation = filter.nationality;
  if (filter.league != null) c.league = filter.league;
  if (filter.club != null) c.club = filter.club;
  if (filter.minPrice != null) c.minBuy = filter.minPrice;
  if (filter.maxPrice != null) c.maxBuy = filter.maxPrice;
  if (filter.minRating != null) c.ovrMin = filter.minRating;
  if (filter.maxRating != null) c.ovrMax = filter.maxRating;
  return c;
}

/** One UTItemEntity -> the fields the model uses (the same privacy seam as
 * `trimAuction`: nothing else about the item leaves this function). */
function trimItem(item: EaItem, seenAt: number): TrimmedAuction | null {
  const a = item.getAuctionData?.();
  if (!a || a.tradeId == null || String(a.tradeId) === '0') return null;
  const expires = Number(a.expires);
  return {
    tradeId: String(a.tradeId),
    resourceId: Number(item.definitionId ?? 0),
    assetId: Number(item.databaseId ?? 0),
    rating: Number(item.rating ?? 0),
    buyNow: Number(a.buyNowPrice ?? 0),
    startingBid: Number(a.startingBid ?? 0),
    currentBid: Number(a.currentBid ?? 0),
    offers: 0,
    expiresAt: Number.isFinite(expires) && expires >= 0 ? seenAt + expires * 1000 : null,
    seenAt,
  };
}

function reportResult(
  action: 'search' | 'buy' | 'readResult',
  requestId: string,
  requestedAt: number,
  ok: boolean,
  error?: string,
): void {
  post('action_result', {
    action,
    requestId,
    ok,
    requestedAt,
    completedAt: Date.now(),
    ...(error ? { error } : {}),
  });
}

function errorText(res: EaResponse): string {
  const code = res.error?.code;
  return code != null ? `EA error ${code}` : `EA status ${res.status ?? 'unknown'}`;
}

async function actSearch(requestId: string, filter: FilterCriteria): Promise<void> {
  const requestedAt = Date.now();
  const probeResult = runProbeAndReport();
  if (!probeResult.ok)
    return reportResult('search', requestId, requestedAt, false, probeResult.reason);
  try {
    const item = ea.services!.Item!;
    // As the app does before showing results: otherwise the same search
    // answers from its page cache and a sniper sees stale listings.
    item.clearTransferMarketCache?.();
    const res = await once(item.searchTransferMarket!(buildSearchCriteria(filter), 1));
    if (!res.success || !Array.isArray(res.data?.items))
      return reportResult('search', requestId, requestedAt, false, errorText(res));
    const seenAt = Date.now();
    const auctions: TrimmedAuction[] = [];
    for (const it of res.data!.items!) {
      const t = trimItem(it, seenAt);
      if (!t) continue;
      auctions.push(t);
      searchedItems.set(t.tradeId, it);
    }
    while (searchedItems.size > MAX_REMEMBERED_ITEMS)
      searchedItems.delete(searchedItems.keys().next().value as string);
    stats.parsed++;
    post('auctions', { url: 'act:search', seenAt, auctions, stats: { ...stats } });
    reportResult('search', requestId, requestedAt, true);
  } catch (err) {
    reportResult(
      'search',
      requestId,
      requestedAt,
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function actBuy(requestId: string, tradeId: string): Promise<void> {
  const requestedAt = Date.now();
  const probeResult = runProbeAndReport();
  if (!probeResult.ok)
    return reportResult('buy', requestId, requestedAt, false, probeResult.reason);
  const item = searchedItems.get(tradeId);
  const auction = item?.getAuctionData?.();
  if (!item || !auction)
    return reportResult('buy', requestId, requestedAt, false, 'listing no longer available');
  try {
    const res = await once(ea.services!.Item!.bid!(item, Number(auction.buyNowPrice)));
    searchedItems.delete(tradeId);
    reportResult(
      'buy',
      requestId,
      requestedAt,
      res.success,
      res.success ? undefined : errorText(res),
    );
  } catch (err) {
    reportResult(
      'buy',
      requestId,
      requestedAt,
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function actReadResult(requestId: string, tradeId: string): Promise<void> {
  const requestedAt = Date.now();
  const auction = searchedItems.get(tradeId)?.getAuctionData?.() as
    (EaAuction & { isBought?: () => boolean }) | undefined;
  post('action_result', {
    action: 'readResult',
    requestId,
    ok: auction != null,
    requestedAt,
    completedAt: Date.now(),
    stillListed: auction ? !(auction.isBought?.() ?? false) : false,
  });
}

// ---- the catalog (model/catalog.ts) -------------------------------------------
//
// Built in two layers so the form never shows empty lists:
//   1. from the web app's public data files (model/catalog-static.ts), as
//      soon as the page has set its `fut_*` globals — no login needed;
//   2. then, once the web app has started, each list is replaced by the web
//      app's own (`factories.DataProvider`, the instance its search panel
//      uses) when that list builds cleanly. Each list on its own: one that
//      fails keeps its layer-1 version.
// Problems are kept in `notes` and shown on the page, not swallowed.

let catalog: Catalog | null = null;
let liveApplied = false;
let building = false;

interface PageGlobals {
  fut_resourceRoot?: string;
  fut_resourceBase?: string;
  fut_guid?: string;
  fut_year?: string;
  factories?: { DataProvider?: Record<string, (...a: unknown[]) => EaDataEntry[]> };
}

function absolute(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, document.baseURI).toString();
  } catch {
    return undefined;
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await nativeFetch.call(window, url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${url.split('?')[0]} -> HTTP ${res.status}`);
  // Some of the web app's JSON files start with a byte-order mark.
  return JSON.parse((await res.text()).replace(/^\uFEFF/, ''));
}

/** The locale file the web app itself loaded, else en-US. */
function webAppLocale(): string {
  try {
    for (const e of performance.getEntriesByType('resource')) {
      const m = /\/web-app\/loc\/([A-Za-z]{2}[-_][A-Za-z]{2})\.json/.exec(e.name);
      if (m) return m[1]!;
    }
  } catch {
    /* fall through */
  }
  return 'en-US';
}

async function buildStaticCatalog(): Promise<Catalog | null> {
  const g = window as unknown as PageGlobals;
  if (!g.fut_resourceRoot || !g.fut_resourceBase || !g.fut_guid || !g.fut_year) return null;
  const base = `${g.fut_resourceRoot}${g.fut_resourceBase}`;
  const root = `${base}${g.fut_guid}/${g.fut_year}/fut/`;
  const web = base.replace(/content\/?$/, '');
  const notes: string[] = [];
  const load = async (url: string): Promise<unknown> => {
    try {
      return await getJson(url);
    } catch (err) {
      notes.push(
        `could not load ${url.split('/').slice(-2).join('/')}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
  const locale = webAppLocale();
  const [teamConfig, locFile, rarityTunables, playersFile] = await Promise.all([
    load(`${root}config/companion/teamconfig.json`),
    load(`${web}loc/${locale}.json`),
    load(`${root}items/images/backgrounds/itemBGs/futcompitemraritytunables.json`),
    load(`${root}items/web/players.json`),
  ]);
  const lists = buildStaticLists({
    root,
    web,
    year: g.fut_year,
    teamConfig,
    loc: locFile && typeof locFile === 'object' ? (locFile as Record<string, unknown>) : {},
    rarityTunables,
  });
  return { players: parsePlayersFile(playersFile), ...lists, capturedAt: Date.now(), notes };
}

/** Replaces each list with the web app's own, where that list builds cleanly. */
function applyLiveLists(c: Catalog): boolean {
  const dp = (window as unknown as PageGlobals).factories?.DataProvider;
  const A = ea.AssetLocationUtils;
  if (!dp || !A || !ea.repositories?.TeamConfig?.getNations?.().length) return false;
  const F = A.FILTER;
  const notes = c.notes ?? (c.notes = []);
  const image = (filter: string | undefined, value: unknown): string | undefined => {
    try {
      return filter ? absolute(A.getFilterImage(filter, value)) : undefined;
    } catch {
      return undefined;
    }
  };
  const opts = (
    dp: EaDataEntry[] | undefined,
    filter: string | undefined,
    byValue = false,
  ): CatalogOption[] =>
    (dp ?? [])
      .filter(
        (e) => e.id !== -1 && e.value !== 'any' && e.value !== '-1' && String(e.label ?? '').trim(),
      )
      .map((e) => ({
        id: Number(e.id),
        value: String(e.value),
        label: String(e.label).trim().slice(0, 120),
        img: image(filter, byValue ? e.value : e.id),
      }));
  const live = (name: string, build: () => CatalogOption[]): CatalogOption[] | null => {
    try {
      const list = build();
      return list.length > 0 ? list : null;
    } catch (err) {
      notes.push(`EA ${name} list: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  const call = (m: string, ...args: unknown[]): EaDataEntry[] => {
    const fn = dp[m];
    if (typeof fn !== 'function') throw new Error(`factories.DataProvider.${m} is missing`);
    return fn.apply(dp, args);
  };

  c.levels = live('quality', () => opts(call('getRareItemLevelDP'), F.LEVEL, true)) ?? c.levels;
  c.rarities =
    live('rarity', () =>
      opts(
        call('getItemRarityDP', {
          itemSubTypes: [],
          itemTypes: [ea.ItemType?.PLAYER ?? 'player'],
          quality: ea.SearchLevel?.ANY ?? 'any',
          tradableOnly: true,
        }),
        F.RARITY,
      ).map((r) => ({
        ...r,
        levels:
          ea.repositories?.Rarity?.getRarity?.(r.id)?.levels === true ||
          c.rarities.find((x) => x.id === r.id)?.levels === true,
      })),
    ) ?? c.rarities;
  c.positions =
    live('position', () =>
      opts(call('getPlayerPositionDP', false), F.POSITION).map((p) =>
        POSITION_ZONES.has(p.id) ? { ...p, value: String(p.id) } : p,
      ),
    ) ?? c.positions;
  c.playStyles =
    live('chemistry style', () => opts(call('getPlayStyleDP'), F.PLAYSTYLE)) ?? c.playStyles;
  c.nations = live('country', () => opts(call('getNationDP'), F.NATION)) ?? c.nations;
  const leagues = live('league', () => opts(call('getLeagueDP', true), F.LEAGUE));
  if (leagues) {
    c.leagues = leagues;
    for (const l of leagues) {
      const clubs = live('club', () => opts(call('getTeamDP', l.id), F.CLUB));
      if (clubs) c.clubs[String(l.id)] = clubs;
    }
  }
  try {
    const p = absolute(A.getPortraitImageUri(987654321));
    if (p) c.portrait = p.replace('987654321', '{id}');
  } catch {
    /* keep the static template */
  }
  c.capturedAt = Date.now();
  return true;
}

/** Builds what it can now and sends it. */
async function refreshCatalog(): Promise<void> {
  if (building) return;
  building = true;
  try {
    if (!catalog) catalog = await buildStaticCatalog();
    if (catalog && !liveApplied) liveApplied = applyLiveLists(catalog);
    if (catalog) post('catalog', catalog);
  } catch (err) {
    if (catalog) (catalog.notes ??= []).push(String(err));
  } finally {
    building = false;
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
  else if (data.action === 'catalog') void refreshCatalog();
});

post('ready', { channel: ADAPTER_CHANNEL });

// The web app starts after this script (document-start), and its data only
// loads after login: wait for it rather than report a failure it has not
// had the chance to pass. The catalog is sent as soon as its first layer can
// be built, and again once the web app's own lists are in.
const STARTUP_POLL_MS = 2_000;
const STARTUP_GIVE_UP_MS = 10 * 60_000;
const startedAt = Date.now();
let probeReported = false;
const startup = setInterval(() => {
  const ready = probe().ok;
  const expired = Date.now() - startedAt > STARTUP_GIVE_UP_MS;
  if (!probeReported && (ready || expired)) {
    probeReported = true;
    runProbeAndReport();
  }
  if (!catalog || !liveApplied) void refreshCatalog();
  if ((probeReported && catalog && liveApplied) || expired) clearInterval(startup);
}, STARTUP_POLL_MS);
