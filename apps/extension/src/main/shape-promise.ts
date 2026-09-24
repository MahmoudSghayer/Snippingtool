/*
 * shape-promise.ts — candidate EA service-layer shape (a): the adapter's
 * original assumption. UNVERIFIED — see
 * docs/06-extension.md §4, day-one checklist.
 *
 *   window.services.Item.repository.search(criteria) -> Promise<{ auctionInfo: [...] }>
 *   window.services.Transfer.repository.buyNow(tradeId) -> Promise<unknown>
 *   window.services.Transfer.repository.bid(tradeId, amount) -> Promise<unknown>
 *     (not called: probed only because its absence says the Transfer
 *     repository is not what this shape assumes)
 *
 * Every call goes through main/ea-response.ts's `settle`, so a repository
 * that turns out to return an observable is observed rather than awaited
 * into a silent success.
 */
import { normaliseListing } from './ea-listing.js';
import { ShapeError, extractListingArray, settle } from './ea-response.js';

import type { BuyTarget, ServiceShape } from './shapes.js';
import type { FilterCriteria } from '@sl/shared';

const apply = Reflect.apply;

type Obj = Record<string, unknown>;

function repository(services: unknown, domain: 'Item' | 'Transfer'): Obj | null {
  const d = (services as Obj | null)?.[domain] as Obj | null | undefined;
  const repo = d && typeof d === 'object' ? d.repository : null;
  return repo && typeof repo === 'object' ? (repo as Obj) : null;
}

function method(services: unknown, domain: 'Item' | 'Transfer', name: string): { target: Obj; fn: (...args: unknown[]) => unknown } | null {
  const repo = repository(services, domain);
  const fn = repo?.[name];
  return repo && typeof fn === 'function' ? { target: repo, fn: fn as (...args: unknown[]) => unknown } : null;
}

/** `filterCriteria` field names mirror the FC web app's own search form;
 * this maps them onto this shape's assumed `search()` argument. Every field
 * is optional both sides: an empty filter is the app's own "browse
 * everything" search. */
export function promiseSearchCriteria(filter: FilterCriteria): Obj {
  const criteria: Obj = {};
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

async function callSearch(services: Obj, criteria: Obj, timeoutMs: number): Promise<{ response: unknown; entries: unknown[] }> {
  const search = method(services, 'Item', 'search');
  if (!search) throw new ShapeError('services.Item.repository.search vanished after the probe passed');
  const response = await settle(apply(search.fn, search.target, [criteria]), timeoutMs);
  return { response, entries: extractListingArray(response) };
}

export function createPromiseShape(timeoutMs: number): ServiceShape {
  return {
    name: 'promise',
    buysOnEntity: false,
    detect(services) {
      if (!method(services, 'Item', 'search')) return 'window.services.Item.repository.search is not a function';
      if (!method(services, 'Transfer', 'buyNow')) return 'window.services.Transfer.repository.buyNow is not a function';
      if (!method(services, 'Transfer', 'bid')) return 'window.services.Transfer.repository.bid is not a function';
      return null;
    },
    search: (services, filter) => callSearch(services, promiseSearchCriteria(filter), timeoutMs),
    async buy(services, target: BuyTarget) {
      const buyNow = method(services, 'Transfer', 'buyNow');
      if (!buyNow) throw new ShapeError('services.Transfer.repository.buyNow vanished after the probe passed');
      // Assumed: resolving means the app accepted the click. An explicit
      // `success: false` (should EA resolve failures rather than reject)
      // is a failure. Day-one checklist: confirm what a failed buyNow does.
      const accepted = (result: unknown): boolean => !(result && typeof result === 'object' && (result as Obj).success === false);
      const onLate = target.onLate ? (result: unknown) => target.onLate!(accepted(result)) : undefined;
      const result = await settle(apply(buyNow.fn, buyNow.target, [target.tradeId]), timeoutMs, onLate);
      if (!accepted(result)) throw new ShapeError('buyNow resolved with success: false');
    },
    async readResult(services, tradeId) {
      const { entries } = await callSearch(services, { tradeIds: [tradeId] }, timeoutMs);
      return entries.some((entry) => normaliseListing(entry)?.tradeId === String(tradeId));
    },
  };
}
