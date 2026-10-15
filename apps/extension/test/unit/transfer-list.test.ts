// The transfer list the Nova AI page counts (`lib/transfer-list.ts`): kept
// from the trade-pile responses EA's own page fetched. A full list replaces
// it, a partial one updates the cards it shows, and nothing is claimed
// until the whole list has been seen once.

import { describe, expect, it } from 'vitest';

import { TRANSFER_LIST_SIZE, createTransferListTracker } from '../../src/lib/transfer-list.js';

import type { TradePileItem } from '@sl/shared';

const card = (itemId: string, tradeState: TradePileItem['tradeState']): TradePileItem => ({
  itemId,
  tradeId: tradeState ? `9${itemId}` : null,
  resourceId: 20801,
  rating: 86,
  tradeState,
  currentBid: 0,
  buyNowPrice: tradeState ? 12_000 : 0,
  expires: tradeState === 'active' ? 3_000 : null,
});

describe('lib/transfer-list.ts', () => {
  it('holds 100 cards, like EA', () => {
    expect(TRANSFER_LIST_SIZE).toBe(100);
  });

  it('knows nothing until EA has loaded the whole list', () => {
    const list = createTransferListTracker();
    expect(list.summary()).toBeNull();
    // A relist shows a few cards, not the list: still nothing to count.
    list.update([card('1', 'active'), card('2', 'active')], false);
    expect(list.summary()).toBeNull();
  });

  it('counts a full list by state', () => {
    let now = 1_000;
    const list = createTransferListTracker({ now: () => now });
    list.update(
      [
        card('1', 'closed'),
        card('2', 'closed'),
        card('3', 'expired'),
        card('4', 'active'),
        card('5', 'active'),
        card('6', 'active'),
        card('7', null),
        card('8', null),
      ],
      true,
    );
    now = 5_000;
    expect(list.summary()).toEqual({
      total: 8,
      sold: 2,
      unsold: 1,
      listed: 3,
      unlisted: 2,
      seenAt: 1_000,
    });
  });

  it('replaces the list with each full one, an empty one included', () => {
    const list = createTransferListTracker();
    list.update([card('1', 'closed'), card('2', 'active'), card('3', 'active')], true);
    list.update([card('2', 'expired')], true);
    expect(list.summary()).toMatchObject({ total: 1, sold: 0, unsold: 1, listed: 0, unlisted: 0 });
    // Everything cleared or moved off: an empty list, which is known.
    list.update([], true);
    expect(list.summary()).toMatchObject({ total: 0, sold: 0, unsold: 0, listed: 0, unlisted: 0 });
  });

  it('updates the cards a partial response shows and adds new ones, keeping the rest', () => {
    let now = 1_000;
    const list = createTransferListTracker({ now: () => now });
    list.update([card('1', 'active'), card('2', 'active'), card('3', null)], true);
    now = 2_000;
    list.update([card('1', 'closed'), card('4', 'expired')], false);
    expect(list.summary()).toEqual({
      total: 4,
      sold: 1,
      unsold: 1,
      listed: 1,
      unlisted: 1,
      seenAt: 2_000,
    });
  });

  it('drops a partial seen before the first full list', () => {
    const list = createTransferListTracker();
    list.update([card('9', 'closed')], false);
    list.update([card('1', 'active')], true);
    expect(list.summary()).toMatchObject({ total: 1, sold: 0, listed: 1 });
  });

  it('counts again only after an update', () => {
    const list = createTransferListTracker();
    list.update([card('1', 'active')], true);
    const first = list.summary();
    expect(list.summary()).toBe(first);
    list.update([card('1', 'closed')], false);
    expect(list.summary()).not.toBe(first);
    expect(list.summary()).toMatchObject({ sold: 1, listed: 0 });
  });
});
