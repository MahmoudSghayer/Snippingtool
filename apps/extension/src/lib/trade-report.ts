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
): { trade: Trade; lifecycle: LifecycleBuy | null } {
  const bought = listing && listing.tradeId === input.tradeId ? listing : undefined;
  const resourceId = bought && bought.resourceId > 0 ? bought.resourceId : input.resourceId;
  const rating = bought && Number.isInteger(bought.rating) && bought.rating >= 0 && bought.rating <= 99 ? bought.rating : null;
  const trade: Trade = {
    id: crypto.randomUUID(),
    tradeId: input.tradeId,
    resourceId,
    assetId: bought && Number.isInteger(bought.assetId) && bought.assetId > 0 ? bought.assetId : null,
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
  const lifecycle: LifecycleBuy | null = bought?.itemId
    ? { itemId: bought.itemId, tradeId: input.tradeId, resourceId, rating, buyPrice: input.buyPrice, boughtAt }
    : null;
  return { trade, lifecycle };
}
