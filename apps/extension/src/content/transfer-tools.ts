/*
 * transfer-tools.ts — the Nova AI page's Transfer list card buttons: Clear
 * sold, and Relist unsold at the same prices, one price step lower or one
 * step higher. Through the adapter's acts only (content/adapter-client.ts),
 * which use the web app's own calls.
 *
 * The same prices go through EA's own Re-list All: one request. A step
 * lower or higher lists each card again on its own, one at a time with a
 * few seconds between (like a trader doing it by hand), so a full list
 * never becomes a burst of requests EA answers with its limits. The new
 * buy-now price is one step of EA's grid from the card's last one, never
 * under EA's lowest; the starting bid one step under it, as auto-sell lists.
 */
import { breakEvenListPrice, MIN_SALE_PRICE, MIN_START_PRICE, stepPrice } from '@sl/shared';

import type { ActionOutcome, AdapterClient } from './adapter-client.js';

export type RelistStep = -1 | 0 | 1;

/** The wait between two cards of a relist at new prices, in ms (random in
 * this range). */
export const RELIST_GAP_MS: readonly [number, number] = [2_500, 4_500];
/** A relist stops once EA has refused this many cards in a row: something
 * is wrong (a full list, a limit), and the rest would only be refused too. */
export const MAX_REFUSED_IN_A_ROW = 3;

export interface TransferToolsDeps {
  adapter: Pick<AdapterClient, 'clearSold' | 'relistAll' | 'unsold' | 'relist'>;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  /** What each card (EA's `itemId`) was bought for, from the trade
   * lifecycle, so a step-lower relist never drops a card under what it cost.
   * Cards it has no cost for are relisted as before. */
  costOf?: (itemIds: string[]) => Promise<Record<string, number>>;
}

export interface ToolResult {
  ok: boolean;
  /** What happened, in the trader's words, for the card. */
  message: string;
}

/** A card's new prices, `step` steps along EA's grid from its last buy-now
 * price, but never below `floor` — the break-even price a card bought for a
 * known cost must not be relisted under, so stepping lower can never list it
 * at a guaranteed loss. `floor` 0 (the default, or a card with no known
 * cost) puts no floor under it beyond EA's own lowest price. */
export function relistPrices(buyNowPrice: number, step: RelistStep, floor = 0): { startPrice: number; buyNowPrice: number } {
  const bin = Math.max(MIN_SALE_PRICE, floor, stepPrice(buyNowPrice, step));
  return { startPrice: Math.max(MIN_START_PRICE, stepPrice(bin, -1)), buyNowPrice: bin };
}

/** Why an act failed, in plain words. */
function why(outcome: ActionOutcome): string {
  const error = outcome.error ?? '';
  if (/_unsupported$|is not a function$/.test(error)) return "EA's page has no such call here (reload EA and try again)";
  if (error === 'relist_not_unsold') return 'the card is no longer unsold';
  if (/timed out/.test(error) || error === 'timeout_unknown') return 'EA did not answer in time';
  return error || 'EA did not say why';
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** EA's Clear Sold. `count`: how many sold cards the list showed, when
 * known, for the message. */
export async function clearSold(deps: TransferToolsDeps, count?: number): Promise<ToolResult> {
  const r = await deps.adapter.clearSold();
  if (!r.ok) return { ok: false, message: `Sold cards not cleared: ${why(r)}` };
  return { ok: true, message: count ? `Cleared ${plural(count, 'sold card')}` : 'Cleared the sold cards' };
}

const STEP_WORDS: Record<RelistStep, string> = { [-1]: 'one step lower', 0: 'at the same prices', 1: 'one step higher' };

/** Every unsold card on the transfer list back on the market, `step` price
 * steps from its last buy-now price. `onProgress` hears each card done. */
export async function relistUnsold(
  deps: TransferToolsDeps,
  step: RelistStep,
  onProgress?: (done: number, total: number) => void,
): Promise<ToolResult> {
  if (step === 0) {
    const r = await deps.adapter.relistAll();
    return r.ok ? { ok: true, message: 'Relisted the unsold cards at the same prices' } : { ok: false, message: `Unsold cards not relisted: ${why(r)}` };
  }
  const read = await deps.adapter.unsold();
  if (!read.ok) return { ok: false, message: `Could not read your transfer list: ${why(read)}` };
  const unsold = read.unsold ?? [];
  // A card listed without a buy-now price has none to step from.
  const cards = unsold.filter((c) => c.buyNowPrice >= MIN_SALE_PRICE);
  if (cards.length === 0) return { ok: true, message: unsold.length === 0 ? 'No unsold cards to relist' : 'No unsold card has a buy-now price to step from' };

  // Stepping lower must never list a card under what it cost: fetch each
  // card's buy price and floor its new price at break-even (after EA's tax).
  // Stepping at the same price or higher can never lose, so no floor is read.
  const costs: Record<string, number> = step < 0 && deps.costOf ? await deps.costOf(cards.map((c) => c.itemId)).catch(() => ({})) : {};

  const random = deps.random ?? Math.random;
  const [low, high] = RELIST_GAP_MS;
  let listed = 0;
  let refused = 0;
  let floored = 0;
  let inARow = 0;
  let lastRefusal: ActionOutcome | null = null;
  let done = 0;
  for (const card of cards) {
    if (done > 0) await deps.sleep(Math.round(low + random() * (high - low)));
    const cost = costs[card.itemId];
    const floor = cost != null && cost > 0 ? breakEvenListPrice(cost) : 0;
    const stepped = Math.max(MIN_SALE_PRICE, stepPrice(card.buyNowPrice, step));
    if (floor > stepped) floored++;
    const p = relistPrices(card.buyNowPrice, step, floor);
    const r = await deps.adapter.relist(card.itemId, p.startPrice, p.buyNowPrice);
    done++;
    if (r.ok) {
      listed++;
      inARow = 0;
    } else {
      refused++;
      inARow++;
      lastRefusal = r;
    }
    onProgress?.(done, cards.length);
    if (inARow >= MAX_REFUSED_IN_A_ROW) break;
  }

  const parts = [`Relisted ${listed} of ${plural(cards.length, 'unsold card')} ${STEP_WORDS[step]}`];
  if (floored > 0) parts.push(`${floored} kept at break-even so you do not sell under what ${floored === 1 ? 'it' : 'they'} cost`);
  if (refused > 0 && lastRefusal) parts.push(`EA refused ${refused}: ${why(lastRefusal)}`);
  if (done < cards.length) parts.push(`stopped after ${MAX_REFUSED_IN_A_ROW} refusals in a row`);
  const left = unsold.length - cards.length;
  if (left > 0) parts.push(`${plural(left, 'card')} without a buy-now price left as ${left === 1 ? 'it is' : 'they are'}`);
  return { ok: listed > 0 && refused === 0, message: parts.join('; ') };
}
