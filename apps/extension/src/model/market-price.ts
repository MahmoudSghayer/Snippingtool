/*
 * market-price.ts — what a card sells for right now, from Nova's own
 * sightings: the price Nova AI's profit estimate and auto-sell fall back on
 * when FUTBIN has none (content/index.ts).
 *
 * Not `summarise()`'s median (model/prices.ts): that is taken over a week of
 * listings, overpriced ones included, so it ran far above what a card sells
 * for (a card FUTBIN priced at 1,900 came out at 2,500, and a 2,200 buy
 * showed as +175 when it was a loss). A card sells at about the cheapest
 * buy-now on the market now, which is what FUTBIN's price is too.
 *
 * So: the listings seen in the last half hour that are still on the market,
 * and the second cheapest of those. Not the cheapest: that one is often a
 * snipe (the very listing being bought), gone in seconds and nothing like
 * the price the card sells at. With fewer than two such listings there is
 * nothing to go on, and the answer is "unknown" (null) rather than a guess.
 */
import type { AuctionRow } from './prices.js';

/** How recently a listing must have been seen to count. */
export const MARKET_RECENT_MS = 30 * 60_000;

export function recentMarketPrice(rows: readonly AuctionRow[] | null | undefined, nowMs = Date.now()): number | null {
  if (!rows) return null;
  const live = rows
    .filter(
      (r) =>
        Number.isFinite(r.buyNow) &&
        r.buyNow > 0 &&
        r.lastSeen >= nowMs - MARKET_RECENT_MS &&
        (r.expiresAt == null || r.expiresAt > nowMs),
    )
    .map((r) => r.buyNow)
    .sort((a, b) => a - b);
  return live.length >= 2 ? live[1]! : null;
}
