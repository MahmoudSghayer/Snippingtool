// Nova AI's Bid mode decisions (`engine/bidder.ts`), without the loop: the
// next valid bid on EA's price grid, which auctions a search's results make
// worth going for (the window, the max bid, Buy Now when cheap), and the book
// of open bids a watch list read brings up to date (won, lost, outbid, gone)
// with the coins those bids hold.

import { type TrimmedAuction, type WatchedAuction } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { BidBook, nextBid, pickAuctions, timeLeft, type TrackedBid } from '../../src/engine/bidder.js';

const NOW = 1_000_000;
const MIN = 60_000;

function auction(tradeId: string, extra: Partial<TrimmedAuction> = {}): TrimmedAuction {
  return {
    tradeId,
    resourceId: 100,
    assetId: 100,
    rating: 85,
    buyNow: 20_000,
    startingBid: 10_000,
    currentBid: 0,
    offers: 0,
    expiresAt: NOW + 3 * MIN,
    seenAt: NOW,
    ...extra,
  };
}

function tracked(tradeId: string, extra: Partial<TrackedBid> = {}): TrackedBid {
  return {
    tradeId,
    resourceId: 100,
    assetId: 100,
    rating: 85,
    maxBid: 12_500,
    amount: 10_000,
    state: 'leading',
    startingBid: 10_000,
    currentBid: 10_000,
    buyNow: 20_000,
    expiresAt: NOW + 3 * MIN,
    itemId: null,
    decision: null,
    missing: 0,
    ...extra,
  };
}

function watched(tradeId: string, extra: Partial<WatchedAuction> = {}): WatchedAuction {
  return {
    tradeId,
    itemId: '9001',
    resourceId: 100,
    assetId: 100,
    rating: 85,
    bidState: 'highest',
    tradeState: 'active',
    currentBid: 10_000,
    startingBid: 10_000,
    buyNowPrice: 20_000,
    expires: 120,
    ...extra,
  };
}

describe('nextBid: the lowest bid EA takes', () => {
  it('is the starting bid while nobody has bid', () => {
    expect(nextBid({ startingBid: 10_000, currentBid: 0 })).toBe(10_000);
    expect(nextBid({ startingBid: 150, currentBid: 0 })).toBe(150);
  });

  it.each([
    // 50 coins below 1,000
    [150, 200],
    [900, 950],
    [950, 1_000],
    // 100 up to 10,000
    [1_000, 1_100],
    [5_400, 5_500],
    [9_900, 10_000],
    // 250 up to 50,000
    [10_000, 10_250],
    [12_250, 12_500],
    [49_750, 50_000],
    // 500 up to 100,000
    [50_000, 50_500],
    [99_500, 100_000],
    // 1,000 above
    [100_000, 101_000],
    [1_250_000, 1_251_000],
  ])('is one step of the grid above a current bid of %i: %i', (current, next) => {
    expect(nextBid({ startingBid: 150, currentBid: current })).toBe(next);
  });
});

describe('timeLeft', () => {
  it('says minutes, or seconds under a minute', () => {
    expect(timeLeft(3 * MIN)).toBe('3 min left');
    expect(timeLeft(4 * MIN + 50_000)).toBe('5 min left');
    expect(timeLeft(45_000)).toBe('45 s left');
    expect(timeLeft(-5)).toBe('0 s left');
  });
});

describe('pickAuctions', () => {
  const opts = (extra: Partial<Parameters<typeof pickAuctions>[1]> = {}) => ({
    now: NOW,
    windowMs: 5 * MIN,
    maxBid: 12_500,
    filter: { resourceId: 100 },
    skip: () => false,
    ...extra,
  });

  it('bids only on auctions in their last minutes (the window)', () => {
    const picks = pickAuctions(
      [auction('in', { expiresAt: NOW + 4 * MIN }), auction('edge', { expiresAt: NOW + 5 * MIN }), auction('early', { expiresAt: NOW + 6 * MIN })],
      opts(),
    );
    expect(picks.map((p) => p.auction.tradeId)).toEqual(['in', 'edge']);
    expect(pickAuctions([auction('early', { expiresAt: NOW + 6 * MIN })], opts({ windowMs: 10 * MIN }))).toHaveLength(1);
  });

  it('bids the next valid bid only while it is at or under the max, and under the buy-now price', () => {
    const picks = pickAuctions(
      [
        auction('fresh', { currentBid: 0, startingBid: 10_000 }),
        auction('bid-on', { currentBid: 12_250 }),
        auction('too-dear', { currentBid: 12_500 }),
        auction('bin-close', { currentBid: 12_250, buyNow: 12_600, startingBid: 10_000 }),
      ],
      opts({ maxBid: 12_500 }),
    );
    expect(picks.map((p) => [p.auction.tradeId, p.action, p.price])).toEqual([
      ['fresh', 'bid', 10_000],
      ['bid-on', 'bid', 12_500],
      ['bin-close', 'bid', 12_500],
    ]);
    // One step under the buy-now price is the most a bid goes: at it, it is a buy.
    expect(pickAuctions([auction('x', { currentBid: 12_250, buyNow: 12_500 })], opts({ maxBid: 12_400 }))).toEqual([]);
  });

  it('buys with Buy Now when the buy-now price is at or under the max, whatever the time left', () => {
    const picks = pickAuctions(
      [auction('bid', { currentBid: 0 }), auction('cheap', { buyNow: 12_000, expiresAt: NOW + 50 * MIN }), auction('cheaper', { buyNow: 11_500 })],
      opts(),
    );
    expect(picks.map((p) => [p.auction.tradeId, p.action, p.price])).toEqual([
      ['cheaper', 'buy', 11_500],
      ['cheap', 'buy', 12_000],
      ['bid', 'bid', 10_000],
    ]);
  });

  it('goes for the soonest-ending auction first', () => {
    const picks = pickAuctions(
      [auction('late', { expiresAt: NOW + 4 * MIN }), auction('soon', { expiresAt: NOW + MIN }), auction('mid', { expiresAt: NOW + 2 * MIN })],
      opts(),
    );
    expect(picks.map((p) => p.auction.tradeId)).toEqual(['soon', 'mid', 'late']);
  });

  it('leaves out what is not for it: known auctions, another card, out of the rating band, ended, unbuyable, no end time', () => {
    const picks = pickAuctions(
      [
        auction('known'),
        auction('other-card', { resourceId: 7, assetId: 7 }),
        auction('special', { resourceId: 5_000_100, assetId: 100 }),
        auction('low-rated', { rating: 80 }),
        auction('ended', { expiresAt: NOW }),
        auction('no-entity', { buyable: false }),
        auction('no-time', { expiresAt: null }),
      ],
      opts({ filter: { resourceId: 100, minRating: 84 }, skip: (id) => id === 'known' }),
    );
    // A special version of the player (same base id) is the player.
    expect(picks.map((p) => p.auction.tradeId)).toEqual(['special']);
  });
});

describe('BidBook', () => {
  it('counts the coins held by bids that lead or may (no answer yet), never by outbid ones', () => {
    const book = new BidBook();
    book.place(tracked('a', { amount: 10_000, state: 'leading' }));
    book.place(tracked('b', { amount: 7_000, state: 'pending' }));
    book.place(tracked('c', { amount: 9_000, state: 'outbid' }));
    expect(book.committed()).toBe(17_000);
    expect(book.size()).toBe(3);
  });

  it('reads a won auction (closed on the trader’s bid) and a lost one, and forgets neither', () => {
    const book = new BidBook();
    book.place(tracked('won'));
    book.place(tracked('lost'));
    const events = book.reconcile(
      [
        watched('won', { tradeState: 'closed', bidState: 'highest', currentBid: 10_000, expires: -1, itemId: '777' }),
        watched('lost', { tradeState: 'closed', bidState: 'outbid', currentBid: 13_000, expires: -1 }),
      ],
      NOW,
    );
    expect(events.map((e) => [e.kind, e.bid.tradeId, 'price' in e ? e.price : null])).toEqual([
      ['won', 'won', 10_000],
      ['lost', 'lost', 13_000],
    ]);
    expect(events[0]!.bid.itemId).toBe('777');
    expect(book.size()).toBe(0);
    // Done with: never picked again.
    expect(book.knows('won') && book.knows('lost')).toBe(true);
  });

  it('marks an outbid bid on every read until it is re-bid or dropped, and keeps its view of the auction fresh', () => {
    const book = new BidBook();
    book.place(tracked('a'));
    const first = book.reconcile([watched('a', { bidState: 'outbid', currentBid: 12_000, expires: 30 })], NOW);
    expect(first.map((e) => e.kind)).toEqual(['outbid']);
    const bid = book.get('a')!;
    expect(bid).toMatchObject({ state: 'outbid', currentBid: 12_000, expiresAt: NOW + 30_000 });
    expect(book.committed()).toBe(0);
    expect(book.reconcile([watched('a', { bidState: 'outbid', currentBid: 12_000 })], NOW).map((e) => e.kind)).toEqual(['outbid']);
    // A bid that leads again (a re-bid landed) holds its coins again.
    expect(book.reconcile([watched('a', { bidState: 'highest', currentBid: 12_250 })], NOW)).toEqual([]);
    expect(book.get('a')).toMatchObject({ state: 'leading', amount: 12_250 });
    expect(book.committed()).toBe(12_250);
  });

  it('confirms a bid with no answer yet when the watch list shows it leading, and treats "none" as not landed', () => {
    const book = new BidBook();
    book.place(tracked('a', { state: 'pending', amount: 10_000 }));
    book.place(tracked('b', { state: 'pending', amount: 10_000 }));
    const events = book.reconcile([watched('a', { bidState: 'highest' }), watched('b', { bidState: 'none', currentBid: 0 })], NOW);
    expect(book.get('a')!.state).toBe('leading');
    expect(events.map((e) => [e.kind, e.bid.tradeId])).toEqual([['outbid', 'b']]);
  });

  it('stops following a bid missing from two reads in a row, not one', () => {
    const book = new BidBook();
    book.place(tracked('a'));
    expect(book.reconcile([], NOW)).toEqual([]);
    expect(book.size()).toBe(1);
    expect(book.reconcile([], NOW).map((e) => e.kind)).toEqual(['gone']);
    expect(book.size()).toBe(0);
  });

  it('leaves an auction that is still running, but past its end on this clock, for the next read to settle', () => {
    const book = new BidBook();
    book.place(tracked('a'));
    expect(book.reconcile([watched('a', { tradeState: 'active', bidState: 'highest', expires: 0 })], NOW)).toEqual([]);
    expect(book.size()).toBe(1);
  });
});
