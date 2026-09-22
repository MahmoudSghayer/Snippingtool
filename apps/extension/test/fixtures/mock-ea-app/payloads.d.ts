/**
 * Ambient types for `payloads.js`, which stays plain JS on purpose (it is
 * served as-is to the mock page by Playwright's route interception, never
 * built) but is also `import()`ed once from `test/e2e/extension.spec.ts` to
 * avoid duplicating the fixture data there.
 */
export interface RawAuction {
  tradeId: number;
  itemData: { resourceId: number; assetId: number; rating: number };
  buyNowPrice: number;
  startingBid: number;
  currentBid: number;
  offers: number;
  expires: number;
}
export interface SearchPage {
  auctionInfo: RawAuction[];
}
export declare const SEARCH_PAGE_1: SearchPage;
export declare const SEARCH_PAGE_2: SearchPage;
