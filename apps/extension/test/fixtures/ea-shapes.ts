// Fixtures for the two candidate EA service-layer shapes main/adapter.ts
// probes for (docs/06-extension.md §4). Neither is verified against the
// live web app — both are the best available description:
//
//   - `promise`: the shape the adapter was first written against
//     (`services.Item.repository.search(criteria) -> Promise<{ auctionInfo }>`,
//     `services.Transfer.repository.buyNow(tradeId)`).
//   - `observable`: what community autobuyers describe
//     (`services.Item.searchTransferMarket(criteria, page)` and
//     `services.Item.bid(item, price)`, each returning an object whose
//     `.observe(scope, (sender, response) => ...)` calls back once with
//     `{ success, data: { items } }`; items are entities exposing their
//     auction through `getAuctionData()` or `_auction`).

import { vi } from 'vitest';

export interface ListingSpec {
  tradeId: number;
  buyNowPrice: number;
  resourceId?: number;
  rating?: number;
  expires?: number;
  /** An auction's bids, and (on the watch list) where the trader's bid
   * stands and the item's own id: Nova AI's Bid mode. */
  startingBid?: number;
  currentBid?: number;
  tradeState?: string;
  bidState?: string;
  itemId?: number;
}

/** One `auctionInfo` entry as the UTAS JSON response carries it. */
export function utasAuction(spec: ListingSpec) {
  return {
    tradeId: spec.tradeId,
    buyNowPrice: spec.buyNowPrice,
    startingBid: 150,
    currentBid: 0,
    offers: 0,
    expires: spec.expires ?? 3600,
    tradeState: 'active',
    itemData: { resourceId: spec.resourceId ?? 42, assetId: spec.resourceId ?? 42, rating: spec.rating ?? 85 },
  };
}

type CardIdKey = 'definitionId' | 'resourceId' | 'maskedDefId';

/** An observable-shape item entity. Its auction lives either behind a
 * prototype method (`getAuctionData()`) or on a `_auction` field, and its
 * card id under whichever of the three names the web app uses. */
export function itemEntity(spec: ListingSpec, options: { accessor?: 'method' | 'field'; idKey?: CardIdKey; name?: string } = {}) {
  const auction: Record<string, unknown> = {
    tradeId: spec.tradeId,
    buyNowPrice: spec.buyNowPrice,
    startingBid: spec.startingBid ?? 150,
    currentBid: spec.currentBid ?? 0,
    offers: 0,
    expires: spec.expires ?? 3600,
    tradeState: spec.tradeState ?? 'active',
  };
  if (spec.bidState) auction.bidState = spec.bidState;
  const entity: Record<string, unknown> =
    options.accessor === 'field'
      ? { _auction: auction }
      : Object.create({
          getAuctionData() {
            return auction;
          },
        });
  entity[options.idKey ?? 'definitionId'] = spec.resourceId ?? 42;
  entity.rating = spec.rating ?? 85;
  if (options.name) entity.name = options.name;
  if (spec.itemId) entity.id = spec.itemId;
  return entity as Record<string, unknown> & { _auction?: typeof auction };
}

/** An observable that calls back once, asynchronously, with `response`
 * — or never, with `respond: false`. */
export function observable(response: unknown, respond = true) {
  const obs = {
    observe: vi.fn((scope: unknown, callback: (sender: unknown, response: unknown) => void) => {
      if (respond) setTimeout(() => callback.call(scope, obs, response), 0);
    }),
    unobserve: vi.fn<() => void>(),
  };
  return obs;
}

export function observableServices() {
  const searchTransferMarket = vi.fn((_criteria: Record<string, unknown>, _page: number): unknown =>
    observable({ success: true, data: { items: [] } }),
  );
  const bid = vi.fn((_item: unknown, _price: number): unknown => observable({ success: true, data: {} }));
  const list = vi.fn(
    (_item: unknown, _start: number, _buyNow: number, _seconds: number): unknown => observable({ success: true, data: {} }),
  );
  const clearTransferMarketCache = vi.fn((): void => undefined);
  const requestTransferItems = vi.fn((): unknown => observable({ success: true, data: { items: [] } }));
  return {
    services: { Item: { searchTransferMarket, bid, list, clearTransferMarketCache, requestTransferItems } },
    searchTransferMarket,
    bid,
    list,
    clearTransferMarketCache,
    requestTransferItems,
  };
}

export function promiseServices() {
  const search = vi.fn(async (_criteria: Record<string, unknown>): Promise<unknown> => ({ auctionInfo: [] }));
  const buyNow = vi.fn(async (_tradeId: string): Promise<unknown> => ({ success: true }));
  return { services: { Item: { repository: { search } }, Transfer: { repository: { buyNow, bid: vi.fn<(...args: unknown[]) => unknown>() } } }, search, buyNow };
}
