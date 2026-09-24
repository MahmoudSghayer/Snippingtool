/*
 * shape-observable.ts — candidate EA service-layer shape (b), as community
 * autobuyers describe the FC web app. UNVERIFIED — see
 * docs/06-extension.md §4, day-one checklist.
 *
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
 */
import { ACT_ERROR } from '../lib/act-auth.js';

import { normaliseListing } from './ea-listing.js';
import { ShapeError, assertSucceeded, extractListingArray, settle } from './ea-response.js';

import type { BuyTarget, ServiceShape } from './shapes.js';
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
 * them. */
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

/** Only an explicit `success: true` is a bought item. */
function bidSucceeded(response: unknown): boolean {
  return response !== null && typeof response === 'object' && (response as Obj).success === true;
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
    async search(services, filter) {
      const criteria = observableSearchCriteria(filter);
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
  };
}
