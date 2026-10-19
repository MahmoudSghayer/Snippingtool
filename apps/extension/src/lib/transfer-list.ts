/*
 * transfer-list.ts — the trader's transfer list as the Nova AI page counts
 * it: how many cards are on it, and how many of those sold, expired unsold,
 * are listed now or sit there unlisted.
 *
 * Passive, like the trade lifecycle (lib/trade-lifecycle.ts): it is fed the
 * trade-pile responses EA's own page already fetched (main/adapter.ts posts
 * them as `tradepile` messages) and never asks EA for anything.
 *
 * A plain GET of `/tradepile` (`full`) is the whole list, so it replaces
 * what is kept. Any other response (a relist, an item move) shows only some
 * cards: each of those is updated or added, and the rest stay as they were.
 * Until a full list has been seen, nothing is known about the cards a
 * partial did not show, so the summary stays null rather than count a few
 * cards as the whole list. A sold card missing from the next full list was
 * cleared (EA's Clear Sold, here or on the Nova AI page): it is still
 * counted as sold (`soldCleared`), so clearing never takes sales away from
 * the page's Sold counter.
 *
 * Kept in memory for the page load only: the list changes whenever the
 * trader uses it, so counts from an earlier load would be out of date.
 * No chrome APIs.
 */
import type { TradePileItem } from '@sl/shared';

/** How many cards EA's transfer list holds. */
export const TRANSFER_LIST_SIZE = 100;

export interface TransferListSummary {
  /** Cards on the list, whatever their state. */
  total: number;
  /** Sold (`closed`), waiting to be cleared. */
  sold: number;
  /** Sold and cleared off the list since this page load. */
  soldCleared: number;
  /** Expired without selling. */
  unsold: number;
  /** On the market now (`active`). */
  listed: number;
  /** On the list but not on the market. */
  unlisted: number;
  /** When EA's page last showed the list (ms since the epoch). */
  seenAt: number;
}

export interface TransferListTracker {
  /** One trade-pile response's items; `full` when it was the whole list. */
  update(items: readonly TradePileItem[], full: boolean): void;
  /** The counts, or null until the whole list has been seen once. */
  summary(): TransferListSummary | null;
}

export function createTransferListTracker(opts: { now?: () => number } = {}): TransferListTracker {
  const now = opts.now ?? Date.now;
  // Each card's state, by EA's itemId (a card's tradeId changes every time
  // it is listed). Null until a full list has been seen.
  let cards: Map<string, TradePileItem['tradeState']> | null = null;
  let seenAt = 0;
  let soldCleared = 0;
  // The page asks for the summary every second while it is open; it is
  // only worked out again after an update.
  let counted: TransferListSummary | null = null;

  return {
    update(items, full) {
      if (full) {
        if (cards) {
          const onList = new Set(items.map((item) => item.itemId));
          for (const [itemId, state] of cards) if (state === 'closed' && !onList.has(itemId)) soldCleared++;
        }
        cards = new Map();
      } else if (!cards) return;
      for (const item of items) cards.set(item.itemId, item.tradeState);
      seenAt = now();
      counted = null;
    },
    summary() {
      if (!cards) return null;
      if (!counted) {
        let sold = 0;
        let unsold = 0;
        let listed = 0;
        for (const state of cards.values()) {
          if (state === 'closed') sold++;
          else if (state === 'expired') unsold++;
          else if (state === 'active') listed++;
        }
        const total = cards.size;
        counted = Object.freeze({
          total,
          sold,
          soldCleared,
          unsold,
          listed,
          unlisted: total - sold - unsold - listed,
          seenAt,
        });
      }
      return counted;
    },
  };
}
