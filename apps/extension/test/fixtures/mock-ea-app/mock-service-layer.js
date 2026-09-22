/*
 * mock-service-layer.js — stands in for the real FC web app for e2e
 * purposes: fires the same passive network traffic `adapter.ts` patches
 * (`fetch` to a UTAS `transfermarket` path), and exposes a fake
 * `window.services` matching `adapter.ts`'s documented ASSUMED SHAPE
 * ("ASSUMED SHAPE — verify on day one" in src/main/adapter.ts) so the e2e
 * test can exercise the act surface (`search`/`buy`) too, not just passive
 * observation.
 */
import { SEARCH_PAGE_1, SEARCH_PAGE_2 } from './payloads.js';

const MARKET_URL = 'https://www.ea.com/ut/game/fc24/transfermarket?start=0&num=21';

/** A human running a search in the real app issues this exact kind of
 * fetch; the route handler in `test/e2e/extension.spec.ts` fulfils it with
 * a recorded payload, so `adapter.ts`'s passive `fetch` patch has something
 * real to observe. */
export async function triggerPassiveSearch() {
  await fetch(MARKET_URL, { method: 'GET' });
}

let nextAuctions = [...SEARCH_PAGE_1.auctionInfo];

/** `window.services.Item.repository.search` / `window.services.Transfer.repository.*`
 * — the ASSUMED SHAPE. Intentionally minimal: enough to prove
 * `adapter.ts`'s probe passes and its act surface round-trips through it. */
window.services = {
  Item: {
    repository: {
      async search(criteria) {
        void criteria;
        return { auctionInfo: nextAuctions };
      },
    },
  },
  Transfer: {
    repository: {
      async buyNow(tradeId) {
        const before = nextAuctions.length;
        nextAuctions = nextAuctions.filter((a) => String(a.tradeId) !== String(tradeId));
        if (nextAuctions.length === before) {
          return { success: false };
        }
        return { success: true };
      },
      async bid(tradeId, amount) {
        void tradeId;
        void amount;
        return { success: true };
      },
    },
  },
};

window.__mock = {
  triggerPassiveSearch,
  loadSecondPage: () => {
    nextAuctions = [...SEARCH_PAGE_2.auctionInfo];
  },
  currentAuctionCount: () => nextAuctions.length,
};

// Fire one passive search shortly after load, the way a human opening the
// transfer market would — gives the e2e test something to assert on without
// needing to script a click through a full mock UI.
setTimeout(() => {
  void triggerPassiveSearch();
}, 50);
