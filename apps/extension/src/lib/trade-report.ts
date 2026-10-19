/*
 * trade-report.ts — the `bought` trade the extension reports when the
 * engine (assist or autobuyer) buys a card, and the matching trade
 * lifecycle entry (lib/trade-lifecycle.ts) that later links it to its sale.
 *
 * Defect C13: the rating used to be whichever card the trader last
 * searched for (`lastRating` in content/index.ts), not the card bought.
 * Now every card field comes from the listing that was bought, looked up
 * by its tradeId; with no such listing the field is null, never a guess.
 * No tax or profit is filled in: the server computes both.
 */
import { EA_TAX_RATE, type LifecycleBuy, type Trade, type TrimmedAuction } from '@sl/shared';

import type { TradeInput } from '../engine/types.js';

export function buildBoughtTrade(
  input: TradeInput,
  listing: TrimmedAuction | undefined,
  boughtAt: string,
): { trade: Trade; lifecycle: LifecycleBuy } {
  const bought = listing && listing.tradeId === input.tradeId ? listing : undefined;
  const resourceId = bought && bought.resourceId > 0 ? bought.resourceId : input.resourceId;
  // The listing's own fields first; then what the engine knew itself (an
  // auction Nova AI won, read off the watch list).
  const validRating = (r: number | null | undefined): r is number => r != null && Number.isInteger(r) && r >= 0 && r <= 99;
  const rating = bought && validRating(bought.rating) ? bought.rating : validRating(input.rating) ? input.rating : null;
  const itemId = bought?.itemId ?? input.itemId ?? null;
  const assetId = bought && Number.isInteger(bought.assetId) && bought.assetId > 0 ? bought.assetId : input.assetId != null && Number.isInteger(input.assetId) && input.assetId > 0 ? input.assetId : null;
  const trade: Trade = {
    id: crypto.randomUUID(),
    tradeId: input.tradeId,
    // The card's own id, stored on the server's trade: another browser
    // signed in to the account follows the card by it
    // (`GET /api/v1/extension/open-trades`) and reports its sale.
    ...(itemId ? { itemId } : {}),
    resourceId,
    assetId,
    rating,
    buyPrice: input.buyPrice,
    sellPrice: null,
    // The schema's tax-rate field (a constant): the server ignores it.
    eaTax: EA_TAX_RATE,
    netProfit: null,
    status: 'bought',
    boughtAt,
    soldAt: null,
  };
  // `itemId: null` when the listing carried none: the buy cannot be
  // followed, and background counts it for the diagnostics report.
  const lifecycle: LifecycleBuy = { itemId, tradeId: input.tradeId, resourceId, rating, buyPrice: input.buyPrice, boughtAt };
  return { trade, lifecycle };
}
