/*
 * shape-observable.ts — candidate EA service-layer shape (b), as community
 * autobuyers describe the FC web app. UNVERIFIED — see
 * docs/06-extension.md §4, day-one checklist.
 *
 *   window.services.Item.clearTransferMarketCache(), then
 *   window.services.Item.searchTransferMarket(criteria, pageNumber)
 *     -> { observe(scope, (sender, response) => ...) }
 *     response: { success: boolean, data: { items: ItemEntity[] } }
 *   window.services.Item.bid(item, price)
 *     -> the same kind of observable; `success: true` means it went through.
 *     Bidding an item's own buy-now price is how the app's UI buys it.
 *
 * Buying takes the item *entity* the search returned, not a tradeId — so
 * this shape can only buy listings the adapter's own act search returned
 * (`buysOnEntity`). A listing seen only passively has no entity, and the
 * adapter refuses it (`listing_entity_unknown`) rather than build one: the
 * adapter never constructs what EA's own UI would not have.
 *
 * Stricter than the promise shape on purpose: a call must return an
 * observable (or a promise), and only an explicit `success: true` is a
 * success. Anything else is an error, never a silent `ok`.
 *
 * Nova AI's Bid mode (`bidding`), ASSUMED SHAPE — verify on day one:
 *
 *   window.services.Item.bid(item, amount)
 *     -> the buy call above with a bid amount instead of the buy-now price.
 *   window.services.Item.requestWatchedItems()
 *     -> observable; seen live (Oct 2026) answering { success: true, status,
 *        error, response, maxAge, retryAfter } with the list inside
 *        `response` (read wherever it sits there: main/ea-response.ts), each
 *        item's auction carrying `bidState` and `tradeState`. Seen live too:
 *        answered from the web app's cache, the same time left and bids
 *        read after read.
 *   window.services.Item.refreshAuctions(items)
 *     -> observable; EA's fresh status for those auctions, onto the web
 *        app's own items (community autobuyers call it between two
 *        requestWatchedItems reads). UNVERIFIED.
 *   window.services.Item.move(item, ItemPile.TRANSFER)
 *     -> observable; `success: true` once the won item is on the transfer
 *        list (`ItemPile` is the web app's own enum of item piles).
 *   window.services.Item.untarget(items)
 *     -> observable; Transfer Targets' "Clear expired": finished auctions
 *        off the watch list.
 *
 *   window.services.Club.search(criteria)
 *     -> observable; the club's items whose definitionId is in
 *        `criteria.defId` (a list), in `response.items`. Gallery mode asks
 *        it which lineup cards the club holds, as the web app's own Player
 *        Picks screen does (FC 27 code: `new UTSearchCriteriaDTO`, only
 *        `defId` set). An item's `isLimitedUse()` is true for a loan.
 *
 * The Nova AI page's transfer list tools, ASSUMED SHAPE as well:
 * `services.Item.clearSoldItems()` (Clear Sold),
 * `services.Item.relistExpiredAuctions()` (Re-list All) and
 * `services.Item.requestTransferItems()` for the list's item entities, each
 * answering through an observable with `success: true`.
 */
import { ACT_ERROR } from '../lib/act-auth.js';

import { normaliseListing, normaliseWatchedItem } from './ea-listing.js';
import { ShapeError, assertSucceeded, extractListingArray, settle } from './ea-response.js';

import type { BidTarget, BiddingShape, BuyTarget, ListTarget, SearchOptions, ServiceShape } from './shapes.js';
import type { FilterCriteria } from '@sl/shared';

const apply = Reflect.apply;
const construct = Reflect.construct;
const objectKeys = Object.keys;
const hasOwn = Object.prototype.hasOwnProperty;

type Obj = Record<string, unknown>;

function itemService(services: unknown): Obj | null {
  const item = (services as Obj | null)?.Item;
  return item && typeof item === 'object' ? (item as Obj) : null;
}

function method(services: unknown, name: string): { target: Obj; fn: (...args: unknown[]) => unknown } | null {
  const item = itemService(services);
  const fn = item?.[name];
  return item && typeof fn === 'function' ? { target: item, fn: fn as (...args: unknown[]) => unknown } : null;
}

/** Filter fields this shape's criteria builder maps, and the criteria
 * field each becomes on EA's `UTSearchCriteriaDTO`, as the FC 27 web app's
 * own search panel sets them (checked against its code, 2026-09-23 — see
 * docs/06-extension.md "Web app shape"): card (`maskedDefId`), buy-now band
 * (`minBuy`/`maxBuy`), rating band (`ovrMin`/`ovrMax`), `position` or a
 * position group (`zone`), `nation`, `league`, `club`, chemistry style
 * (`playStyle`), rarity (`rarities`, a one-element list) and quality as
 * `level`. `minBid`/`maxBid` exist on the DTO but no filter field feeds
 * them: Bid mode's search sets `maxBid` from its own option
 * (`SearchOptions`). */
const CRITERIA_FIELDS: Record<string, string> = {
  resourceId: 'maskedDefId',
  minPrice: 'minBuy',
  maxPrice: 'maxBuy',
  minRating: 'ovrMin',
  maxRating: 'ovrMax',
  position: 'position',
  zone: 'zone',
  nationality: 'nation',
  league: 'league',
  club: 'club',
  quality: 'level',
  rarity: 'rarities',
  chemistryStyle: 'playStyle',
};

/** `quality` values onto `level`: the three metals by name, and special
 * cards as `SP` (community autobuyers; unverified). */
const LEVELS: Record<string, string> = { bronze: 'bronze', silver: 'silver', gold: 'gold', special: 'SP' };

/** The search criteria for `filter`: an instance of the app's own
 * `UTSearchCriteriaDTO` when the page has one (what its search form
 * builds), else a plain object, with `type` set to a player search FIRST —
 * the DTO's `type` setter resets nation, position, rarities and play style.
 * A filter field this builder cannot map is refused rather than dropped —
 * dropping it would search wider than the filter says. A position group
 * (`zone`) is searched instead of a single `position`, as EA's panel does. */
export function observableSearchCriteria(filter: FilterCriteria): Obj {
  const f = filter as Obj;
  const unmapped = objectKeys(f).filter((key) => f[key] != null && !apply(hasOwn, CRITERIA_FIELDS, [key]));
  if (f.quality != null && !apply(hasOwn, LEVELS, [String(f.quality)])) unmapped.push(`quality=${String(f.quality)}`);
  if (unmapped.length > 0) {
    throw new ShapeError(`the observable shape cannot search by ${unmapped.join(', ')} yet (maps only ${objectKeys(CRITERIA_FIELDS).join(', ')})`);
  }
  const Dto = (window as unknown as Obj).UTSearchCriteriaDTO;
  let criteria: Obj = {};
  if (typeof Dto === 'function') {
    try {
      criteria = construct(Dto as new () => Obj, []);
    } catch {
      criteria = {};
    }
  }
  const searchType = ((window as unknown as Obj).SearchType as Obj | undefined)?.PLAYER;
  criteria.type = typeof searchType === 'string' && searchType !== '' ? searchType : 'player';
  for (const key of objectKeys(CRITERIA_FIELDS)) {
    if (f[key] == null) continue;
    if (key === 'position' && f.zone != null) continue;
    const value = key === 'quality' ? LEVELS[String(f[key])] : key === 'rarity' ? [f[key]] : f[key];
    criteria[CRITERIA_FIELDS[key]!] = value;
  }
  return criteria;
}

function isAsync(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof (value as Obj).observe === 'function' || typeof (value as Obj).then === 'function';
}

async function call(services: Obj, name: string, args: unknown[], timeoutMs: number, onLate?: (response: unknown) => void): Promise<unknown> {
  const m = method(services, name);
  if (!m) throw new ShapeError(`services.Item.${name} vanished after the probe passed`);
  const returned = apply(m.fn, m.target, args);
  if (!isAsync(returned)) throw new ShapeError(`services.Item.${name} returned neither an observable nor a promise`);
  return settle(returned, timeoutMs, onLate);
}

/** What the web app calls before every transfer-market search (FC 27 code,
 * docs/06-extension.md "Web app shape"): without it `searchTransferMarket`
 * answers an identical search from its page cache, so a bot repeating one
 * search kept seeing the same stale page and almost never a new listing.
 * A page without it, or a clear that throws, still searches. */
function clearMarketCache(services: unknown): void {
  const m = method(services, 'clearTransferMarketCache');
  if (!m) return;
  try {
    apply(m.fn, m.target, []);
  } catch {
    // The search itself still runs.
  }
}

/** Only an explicit `success: true` is a bought (or listed) item. */
function bidSucceeded(response: unknown): boolean {
  return response !== null && typeof response === 'object' && (response as Obj).success === true;
}

/** The web app's own id for one of its item piles (`ItemPile.TRANSFER`,
 * `ItemPile.CLUB`), or null when the page has no such enum. */
function itemPile(name: 'TRANSFER' | 'CLUB'): number | string | null {
  const pile = ((window as unknown as Obj).ItemPile as Obj | undefined)?.[name];
  return typeof pile === 'number' || (typeof pile === 'string' && pile !== '') ? pile : null;
}

/** The transfer list pile (`ItemPile.TRANSFER`), or null. */
function transferPile(): number | string | null {
  return itemPile('TRANSFER');
}

/** Longest a watch list read waits on `refreshAuctions`. */
const REFRESH_TIMEOUT_MS = 4_000;

/** Bid mode on this shape (see the header: ASSUMED SHAPE). */
function createBidding(timeoutMs: number): BiddingShape {
  return {
    detect(services) {
      if (!method(services, 'bid')) return 'window.services.Item.bid is not a function';
      if (!method(services, 'requestWatchedItems')) return 'window.services.Item.requestWatchedItems is not a function';
      return null;
    },
    async bid(services, target: BidTarget) {
      // The entity is what `bid` acts on: it must be this very auction.
      const listing = normaliseListing(target.entity);
      if (!listing || listing.tradeId !== target.tradeId) throw new ShapeError(ACT_ERROR.priceMismatch);
      // A TimeoutUnknownError propagates as-is: the bid may have gone
      // through, and the next watch list read says whether it did.
      const response = await call(services, 'bid', [target.entity, target.amount], timeoutMs);
      const r = assertSucceeded(response, 'bid', true);
      if (!bidSucceeded(r)) throw new ShapeError('bid did not report success: true');
    },
    async readWatchlist(services) {
      // requestWatchedItems answers from the web app's own cache: live, five
      // bids read "leading, 0:24 left" for minutes while they were outbid
      // and ended, and all showed lost at once when the cache ran out. So,
      // as community autobuyers do: clear the market cache, read the list,
      // have EA refresh its running auctions (refreshAuctions, what Transfer
      // Targets uses to keep its timers and bids live), and read it again.
      // Without refreshAuctions, or when it fails, the first read stands.
      clearMarketCache(services);
      const read = async () => {
        const response = await call(services, 'requestWatchedItems', [], timeoutMs);
        return { response, entries: extractListingArray(response, { requireSuccess: true, what: 'requestWatchedItems' }) };
      };
      const first = await read();
      const running = first.entries.filter((e) => normaliseWatchedItem(e)?.tradeState === 'active');
      if (running.length === 0 || !method(services, 'refreshAuctions')) return first;
      try {
        // A refresh that hangs must not hold the read: past REFRESH_TIMEOUT_MS
        // the first read stands.
        assertSucceeded(await call(services, 'refreshAuctions', [running], Math.min(timeoutMs, REFRESH_TIMEOUT_MS)), 'refreshAuctions');
      } catch {
        return first;
      }
      return read();
    },
    async moveToTransferList(services, entity) {
      if (!method(services, 'move')) throw new ShapeError('window.services.Item.move is not a function');
      const pile = transferPile();
      if (pile === null) throw new ShapeError('window.ItemPile.TRANSFER is not available');
      const response = await call(services, 'move', [entity, pile], timeoutMs);
      const r = assertSucceeded(response, 'move', true);
      if (!bidSucceeded(r)) throw new ShapeError('move did not report success: true');
    },
    async moveToClub(services, entity) {
      // The same call as "Send to My Club" in the web app: Item.move to
      // ItemPile.CLUB. EA refuses a card the club already holds.
      if (!method(services, 'move')) throw new ShapeError('window.services.Item.move is not a function');
      const pile = itemPile('CLUB');
      if (pile === null) throw new ShapeError('window.ItemPile.CLUB is not available');
      const response = await call(services, 'move', [entity, pile], timeoutMs);
      const r = assertSucceeded(response, 'move', true);
      if (!bidSucceeded(r)) throw new ShapeError('move to club did not report success: true');
    },
    async clubOwned(services, resourceIds) {
      const club = (services as Obj).Club as Obj | undefined;
      const search = club?.search;
      if (!club || typeof search !== 'function') throw new ShapeError('window.services.Club.search is not a function');
      const Dto = (window as unknown as Obj).UTSearchCriteriaDTO;
      if (typeof Dto !== 'function') throw new ShapeError('window.UTSearchCriteriaDTO is not available');
      const criteria = construct(Dto as new () => Obj, []);
      criteria.defId = [...resourceIds];
      const returned = apply(search as (...args: unknown[]) => unknown, club, [criteria]);
      if (!isAsync(returned)) throw new ShapeError('services.Club.search returned neither an observable nor a promise');
      const r = assertSucceeded(await settle(returned, timeoutMs), 'Club.search', true);
      const items = ((r as Obj).response as Obj | undefined)?.items;
      if (!Array.isArray(items)) throw new ShapeError('Club.search answered without an item list');
      const asked = new Set(resourceIds);
      const owned = new Set<number>();
      for (const item of items as Obj[]) {
        const id = item?.definitionId;
        if (typeof id !== 'number' || !asked.has(id)) continue;
        // A loan does not count for the Gallery.
        const limited = item.isLimitedUse;
        if (typeof limited === 'function' && apply(limited as () => unknown, item, []) === true) continue;
        owned.add(id);
      }
      return [...owned];
    },
    async untarget(services, entities) {
      // Transfer Targets' "Clear expired", as community autobuyers describe
      // it: services.Item.untarget(items) -> observable. UNVERIFIED.
      if (!method(services, 'untarget')) throw new ShapeError('window.services.Item.untarget is not a function');
      const r = assertSucceeded(await call(services, 'untarget', [entities], timeoutMs), 'untarget', true);
      if (!bidSucceeded(r)) throw new ShapeError('untarget did not report success: true');
    },
  };
}

export function createObservableShape(timeoutMs: number): ServiceShape {
  return {
    name: 'observable',
    buysOnEntity: true,
    detect(services) {
      if (!method(services, 'searchTransferMarket')) return 'window.services.Item.searchTransferMarket is not a function';
      if (!method(services, 'bid')) return 'window.services.Item.bid is not a function';
      return null;
    },
    async search(services, filter, options: SearchOptions = {}) {
      const criteria = observableSearchCriteria(filter);
      if (options.maxBid !== undefined) criteria.maxBid = options.maxBid;
      clearMarketCache(services);
      const response = await call(services, 'searchTransferMarket', [criteria, 1], timeoutMs);
      // `success` must be there and true: a list with no verdict is not one.
      return { response, entries: extractListingArray(response, { requireSuccess: true }) };
    },
    async buy(services, target: BuyTarget) {
      // The price re-check against the adapter's last-seen listing has
      // passed; re-check the entity too, since it is what `bid` acts on.
      const listing = normaliseListing(target.entity);
      if (!listing || listing.tradeId !== target.tradeId || listing.buyNowPrice !== target.price) {
        throw new ShapeError(ACT_ERROR.priceMismatch);
      }
      // A bid EA answers after the adapter stopped waiting is reported
      // late, through `onLate`: the buy may well have gone through.
      const onLate = target.onLate ? (response: unknown) => target.onLate!(bidSucceeded(response)) : undefined;
      // A TimeoutUnknownError propagates as-is: the adapter reports it as
      // `timeout_unknown`, not as a failed buy.
      const response = await call(services, 'bid', [target.entity, target.price], timeoutMs, onLate);
      const r = assertSucceeded(response, 'bid', true);
      if (!bidSucceeded(r)) throw new ShapeError('bid did not report success: true');
    },
    async readResult() {
      // No verified call for a single trade's status in this shape (a
      // guess would be `refreshAuctions`); fail loud rather than guess.
      throw new ShapeError('readResult is not supported by the observable shape (no verified trade-status call)');
    },
    async list(services, target: ListTarget) {
      // The web app's own "List on Transfer Market", as community
      // autobuyers describe it: services.Item.list(item, startingBid,
      // buyNowPrice, durationSeconds) -> observable. UNVERIFIED like the
      // rest of this shape; only an explicit `success: true` counts.
      if (!method(services, 'list')) throw new ShapeError('window.services.Item.list is not a function');
      const response = await call(
        services,
        'list',
        [target.entity, target.startPrice, target.buyNowPrice, target.durationSeconds],
        timeoutMs,
      );
      const r = assertSucceeded(response, 'list', true);
      if (!bidSucceeded(r)) throw new ShapeError('list did not report success: true');
    },
    async refreshPile(services) {
      // What the web app calls when its Transfer List opens, as community
      // autobuyers describe it: services.Item.requestTransferItems() ->
      // observable. UNVERIFIED like the rest of this shape. Its GET of the
      // trade pile is read by passive observation (main/adapter.ts).
      if (!method(services, 'requestTransferItems')) throw new ShapeError('window.services.Item.requestTransferItems is not a function');
      const response = await call(services, 'requestTransferItems', [], timeoutMs);
      const r = assertSucceeded(response, 'requestTransferItems', true);
      if (!bidSucceeded(r)) throw new ShapeError('requestTransferItems did not report success: true');
    },
    async readPile(services) {
      // The same call, for its items: the entities `list` takes.
      if (!method(services, 'requestTransferItems')) throw new ShapeError('window.services.Item.requestTransferItems is not a function');
      const response = await call(services, 'requestTransferItems', [], timeoutMs);
      return extractListingArray(response, { requireSuccess: true, what: 'requestTransferItems' });
    },
    async clearSold(services) {
      // The Transfer List's "Clear Sold", as community autobuyers describe
      // it: services.Item.clearSoldItems() -> observable. UNVERIFIED.
      if (!method(services, 'clearSoldItems')) throw new ShapeError('window.services.Item.clearSoldItems is not a function');
      const r = assertSucceeded(await call(services, 'clearSoldItems', [], timeoutMs), 'clearSoldItems', true);
      if (!bidSucceeded(r)) throw new ShapeError('clearSoldItems did not report success: true');
    },
    async relistAll(services) {
      // Its "Re-list All": services.Item.relistExpiredAuctions() ->
      // observable, every expired card at its last prices. UNVERIFIED.
      if (!method(services, 'relistExpiredAuctions')) throw new ShapeError('window.services.Item.relistExpiredAuctions is not a function');
      const r = assertSucceeded(await call(services, 'relistExpiredAuctions', [], timeoutMs), 'relistExpiredAuctions', true);
      if (!bidSucceeded(r)) throw new ShapeError('relistExpiredAuctions did not report success: true');
    },
    // Automation builds only: the listable build carries no Bid mode code.
    bidding: import.meta.env.VITE_AUTOMATION === '1' ? createBidding(timeoutMs) : undefined,
  };
}
