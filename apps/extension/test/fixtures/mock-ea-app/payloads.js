/*
 * payloads.js — recorded-shape UTAS `transfermarket` JSON payloads, close to
 * what the real endpoint returns (`auctionInfo[]` of `{ tradeId, itemData:
 * { resourceId, assetId, rating }, buyNowPrice, startingBid, currentBid,
 * offers, expires }`), used by `mock-service-layer.js` to answer both the
 * passive `fetch()` the page fires on load and the ASSUMED-SHAPE
 * `window.services.Item.repository.search()` call the act surface drives.
 */
function auction(i, overrides = {}) {
  return {
    tradeId: 1_000_000 + i,
    itemData: { resourceId: 200000 + (i % 5), assetId: 200000 + (i % 5), rating: 83 + (i % 6) },
    buyNowPrice: 1000 + i * 137,
    startingBid: 800 + i * 100,
    currentBid: 800 + i * 100,
    offers: i % 3,
    expires: 300 + i * 17, // seconds remaining, per the real UTAS shape
    ...overrides,
  };
}

export const SEARCH_PAGE_1 = {
  auctionInfo: Array.from({ length: 21 }, (_, i) => auction(i)),
};

export const SEARCH_PAGE_2 = {
  auctionInfo: Array.from({ length: 10 }, (_, i) => auction(i + 21)),
};
