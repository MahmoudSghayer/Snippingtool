/*
 * bidder.ts — Nova AI's Bid mode: which auctions to go for, what to bid, and
 * the book of auctions holding one of the bot's bids. Pure: no adapter, no
 * timers. The loop that runs it — pacing, breaks and rests, every hourly
 * limit, EA's rate limits, the kill switch, the plan and the engine lease —
 * is the Sniper's own (engine/sniper.ts, `runBids`): one engine runs
 * whichever mode the user picked (only one at a time), so every safety rail
 * exists once and applies to both.
 *
 * How Bid mode decides (`pickAuctions`):
 *   - The max price of the search is the max bid: the bot never bids, or
 *     re-bids, above it.
 *   - An auction whose buy-now price is at or under the max is bought with
 *     Buy Now (Snipe mode's own buy path and limits), whatever its time
 *     left: that is cheaper than winning it.
 *   - Otherwise it bids only in an auction's last minutes (the user's
 *     window, 5 by default), and only when the next valid bid (`nextBid`:
 *     the starting bid while nobody has bid, else one step of EA's price
 *     grid above the current bid) is at or under the max and below the
 *     buy-now price. Cheapest bid first, and at the same bid the one
 *     ending soonest (the trader's choice).
 *
 * Every bid lands on the trader's watch list (EA's Transfer Targets). Reading
 * it (`BidBook.reconcile`) says which bids still lead, which were outbid
 * (the loop re-bids the next step while that is at or under the max, else
 * drops the auction), and which auctions were won or lost. A dropped or
 * lost auction is left on the watch list as EA keeps it: no web app call to
 * take one off it is known, and guessing one is not worth a request EA's
 * own UI would not make; the trader clears them with EA's "Clear expired".
 *
 * EA holds a bid's coins while it leads. `committed()` is what the bot's own
 * bids hold, counted against the session coin budget and the coins EA says
 * the trader has; the governor holds the same coins in its hourly coin flow
 * (`Governor.allow({ kind: 'bid' })`) until a bid is outbid or lost.
 */
import { stepPrice, type FilterCriteria, type TrimmedAuction, type WatchedAuction } from '@sl/shared';

import type { GovernorDecision } from './governor.js';

/** EA's watch list (Transfer Targets), where every bid lands, holds about
 * this many auctions: a bid needs room there. */
export const WATCHLIST_SIZE = 50;

/** Watch list reads an open bid may be missing from before the bot stops
 * following it (the trader may have taken it off, or the bid never landed). */
const MISSING_READS_BEFORE_GONE = 2;

/** Auctions the bot is done with, remembered so a later search never bids
 * on one again: past this, the oldest are forgotten. */
const MAX_DONE_REMEMBERED = 1_000;

/** The lowest bid EA takes on an auction: its starting bid while nobody has
 * bid, else one step of EA's price grid above the current bid (50 coins
 * under 1,000, 100 up to 10,000, 250 up to 50,000, 500 up to 100,000, then
 * 1,000). The adapter checks every bid against the same rule
 * (main/ea-listing.ts, `nextBidPrice`). */
export function nextBid(a: { startingBid: number; currentBid: number }): number {
  return a.currentBid > 0 ? stepPrice(a.currentBid, 1) : a.startingBid;
}

/** "3 min left", "45 s left": an auction's time left, for the log. */
export function timeLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.round(s / 60)} min left` : `${s} s left`;
}

/** An auction worth going for: buy it (`price` is its buy-now price) or bid
 * on it (`price` is the next valid bid). */
export interface BidPick {
  auction: TrimmedAuction;
  action: 'buy' | 'bid';
  price: number;
}

/** Whether a listing is the search's card: Snipe mode's own check (a player
 * target holds EA's base player id; a special version of that player has
 * its own resourceId but the same assetId), and the rating band. */
function isTarget(a: TrimmedAuction, f: FilterCriteria): boolean {
  if (f.resourceId != null && a.resourceId !== f.resourceId && a.assetId !== f.resourceId) return false;
  if (f.minRating != null && a.rating < f.minRating) return false;
  if (f.maxRating != null && a.rating > f.maxRating) return false;
  return true;
}

/** What to do with a search's auctions (see the header): buys first,
 * cheapest first, then bids: the lowest bid first, and at the same bid the
 * one ending soonest. `skip`: auctions the bot
 * already bids on or is done with. */
export function pickAuctions(
  auctions: Iterable<TrimmedAuction>,
  opts: { now: number; windowMs: number; maxBid: number; filter: FilterCriteria; skip: (tradeId: string) => boolean },
): BidPick[] {
  const buys: BidPick[] = [];
  const bids: BidPick[] = [];
  for (const a of auctions) {
    // The adapter could not act on it (no item entity to bid on), or it
    // came from somewhere other than this search.
    if (a.buyable === false || !isTarget(a, opts.filter) || opts.skip(a.tradeId)) continue;
    const left = a.expiresAt == null ? null : a.expiresAt - opts.now;
    if (left != null && left <= 0) continue;
    if (a.buyNow > 0 && a.buyNow <= opts.maxBid) {
      buys.push({ auction: a, action: 'buy', price: a.buyNow });
      continue;
    }
    if (left == null || left > opts.windowMs) continue;
    const bid = nextBid(a);
    if (bid > opts.maxBid || (a.buyNow > 0 && bid >= a.buyNow)) continue;
    bids.push({ auction: a, action: 'bid', price: bid });
  }
  buys.sort((x, y) => x.price - y.price);
  bids.sort((x, y) => x.price - y.price || x.auction.expiresAt! - y.auction.expiresAt!);
  return [...buys, ...bids];
}

/** Where one of the bot's bids stands: `pending` (EA did not answer in time:
 * it may lead, and the next watch list read says), `leading`, or `outbid`
 * (waiting for a re-bid, or for the limits to allow one). */
export type BidState = 'pending' | 'leading' | 'outbid';

/** An auction holding one of the bot's bids. */
export interface TrackedBid {
  tradeId: string;
  resourceId: number;
  assetId: number;
  rating: number;
  /** The most the bot bids on it: the max price when it first bid. */
  maxBid: number;
  /** The bot's own last bid. */
  amount: number;
  state: BidState;
  /** The auction as last seen. */
  startingBid: number;
  currentBid: number;
  buyNow: number;
  expiresAt: number;
  itemId: string | null;
  /** The governor's decision for the last bid, which holds its coins in the
   * hourly coin flow until it is outbid or lost; null once given back. */
  decision: GovernorDecision | null;
  /** Watch list reads in a row it was missing from. */
  missing: number;
  /** Re-bids in a row EA refused because someone else's bid got there
   * first (`Sniper.placeBid` lets the auction go at MAX_REBID_REFUSALS). */
  refused?: number;
  /** The current bid the search results last showed it outbid at, so each
   * time the trader loses the lead shows once (`Sniper.rebid`). */
  outbidShown?: number;
}

/** What a watch list read said about one of the bot's bids. `price`: what
 * the auction went for. */
export type BidEvent =
  | { kind: 'won'; bid: TrackedBid; price: number }
  | { kind: 'lost'; bid: TrackedBid; price: number }
  | { kind: 'outbid'; bid: TrackedBid }
  | { kind: 'gone'; bid: TrackedBid };

export class BidBook {
  private readonly open = new Map<string, TrackedBid>();
  /** Auctions won, lost or dropped: never bid on again. */
  private readonly done = new Set<string>();

  /** The bot's open bids, soonest-ending first. */
  bids(): TrackedBid[] {
    return [...this.open.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  }

  size(): number {
    return this.open.size;
  }

  get(tradeId: string): TrackedBid | undefined {
    return this.open.get(tradeId);
  }

  /** Whether the bot bids on this auction, or is done with it. */
  knows(tradeId: string): boolean {
    return this.open.has(tradeId) || this.done.has(tradeId);
  }

  /** Coins EA holds for the bot's bids: every bid that leads, or may
   * (`pending`). An outbid one holds nothing (EA gave its coins back). */
  committed(): number {
    let sum = 0;
    for (const b of this.open.values()) if (b.state !== 'outbid') sum += b.amount;
    return sum;
  }

  /** A new bid, or a new amount on one already open. */
  place(bid: TrackedBid): void {
    this.open.set(bid.tradeId, bid);
  }

  /** The bot is done with an auction: it never bids on it again. */
  close(tradeId: string): void {
    this.open.delete(tradeId);
    this.done.add(tradeId);
    if (this.done.size > MAX_DONE_REMEMBERED) this.done.delete(this.done.values().next().value!);
  }

  /**
   * Brings every open bid in line with a watch list read (`now`: when it
   * was read) and says what changed. An auction EA says has ended is won
   * when it closed on the trader's bid (`closed`, `highest`), else lost; a
   * running one the trader no longer leads is outbid (every read, until the
   * loop re-bids or drops it). Won and lost auctions leave the book.
   */
  reconcile(watched: readonly WatchedAuction[], now: number): BidEvent[] {
    const byTrade = new Map(watched.map((w) => [w.tradeId, w]));
    const events: BidEvent[] = [];
    for (const bid of this.bids()) {
      const w = byTrade.get(bid.tradeId);
      if (!w) {
        bid.missing++;
        if (bid.missing >= MISSING_READS_BEFORE_GONE) {
          this.close(bid.tradeId);
          events.push({ kind: 'gone', bid });
        }
        continue;
      }
      bid.missing = 0;
      bid.startingBid = w.startingBid;
      bid.currentBid = w.currentBid;
      bid.buyNow = w.buyNowPrice;
      if (w.expires != null) bid.expiresAt = now + w.expires * 1000;
      if (w.itemId) bid.itemId = w.itemId;
      if (w.tradeState === 'closed' || w.tradeState === 'expired') {
        this.close(bid.tradeId);
        const won = w.tradeState === 'closed' && w.bidState === 'highest';
        events.push(won ? { kind: 'won', bid, price: w.currentBid } : { kind: 'lost', bid, price: w.currentBid });
        continue;
      }
      if (w.bidState === 'highest') {
        bid.state = 'leading';
        bid.amount = w.currentBid;
        continue;
      }
      // Outbid, or never landed (`none`): the bot no longer leads it.
      bid.state = 'outbid';
      events.push({ kind: 'outbid', bid });
    }
    return events;
  }
}
