// Unit coverage for the adapter's shape-independent response handling
// (main/ea-response.ts, main/ea-listing.ts): whatever a service-layer call
// hands back — a Promise, an observable, a UTAS JSON envelope or a list of
// item entities — either becomes a list of normalised listings or an error.
// Never an `ok` with nothing in it because the envelope was not understood.

import { describe, expect, it } from 'vitest';

import { normaliseListing, normaliseListings } from '../../src/main/ea-listing.js';
import { extractListingArray, settle } from '../../src/main/ea-response.js';
import { itemEntity, observable, utasAuction } from '../fixtures/ea-shapes.js';

describe('normaliseListing', () => {
  it('reads a UTAS auctionInfo entry', () => {
    expect(normaliseListing(utasAuction({ tradeId: 1, buyNowPrice: 900, resourceId: 7, rating: 84 }))).toMatchObject({
      tradeId: '1',
      buyNowPrice: 900,
      resourceId: 7,
      assetId: 7,
      rating: 84,
      expires: 3600,
    });
  });

  it('reads an entity through getAuctionData()', () => {
    expect(normaliseListing(itemEntity({ tradeId: 2, buyNowPrice: 1200, resourceId: 8 }, { accessor: 'method' }))).toMatchObject({
      tradeId: '2',
      buyNowPrice: 1200,
      resourceId: 8,
      tradeState: 'active',
    });
  });

  it('reads an entity through _auction', () => {
    expect(normaliseListing(itemEntity({ tradeId: 3, buyNowPrice: 1300, resourceId: 9 }, { accessor: 'field' }))).toMatchObject({
      tradeId: '3',
      buyNowPrice: 1300,
      resourceId: 9,
    });
  });

  it.each(['definitionId', 'resourceId', 'maskedDefId'] as const)('takes the card id from %s', (idKey) => {
    expect(normaliseListing(itemEntity({ tradeId: 4, buyNowPrice: 100, resourceId: 55 }, { idKey }))?.resourceId).toBe(55);
  });

  it('keeps the name when there is one', () => {
    expect(normaliseListing(itemEntity({ tradeId: 5, buyNowPrice: 100 }, { name: 'Somebody' }))?.name).toBe('Somebody');
  });

  it.each([
    ['null', null],
    ['a string', 'listing'],
    ['no tradeId', { buyNowPrice: 100, itemData: { resourceId: 1 } }],
    ['no card id', { tradeId: 1, buyNowPrice: 100, itemData: {} }],
    ['a non-numeric price', { tradeId: 1, buyNowPrice: 'cheap', itemData: { resourceId: 1 } }],
    ['a getAuctionData that throws', { definitionId: 1, getAuctionData: () => { throw new Error('boom'); } }],
  ])('returns null for %s', (_label, entry) => {
    expect(normaliseListing(entry)).toBeNull();
  });
});

describe('normaliseListings', () => {
  it('returns an empty list for an empty page of results', () => {
    expect(normaliseListings([])).toEqual([]);
  });

  it('skips unreadable entries among readable ones', () => {
    expect(normaliseListings([utasAuction({ tradeId: 1, buyNowPrice: 1 }), { junk: true }])).toHaveLength(1);
  });

  it('throws when not one of several results can be read', () => {
    expect(() => normaliseListings([{ junk: true }, { more: 'junk' }])).toThrow(/none of the 2/);
  });
});

describe('extractListingArray', () => {
  it.each([
    ['auctionInfo', { auctionInfo: [1] }],
    ['items', { items: [1] }],
    ['data.items', { success: true, data: { items: [1] } }],
    ['data.auctionInfo', { data: { auctionInfo: [1] } }],
  ])('finds the array under %s', (_label, response) => {
    expect(extractListingArray(response)).toEqual([1]);
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'ok'],
    ['an object with no list', { foo: 1 }],
    ['a non-array auctionInfo', { auctionInfo: 'x' }],
    ['success with no data', { success: true, data: {} }],
    ['success with a null list', { success: true, data: { items: null } }],
  ])('throws for %s', (_label, response) => {
    expect(() => extractListingArray(response)).toThrow();
  });

  it('throws when the response says it failed, even with a list', () => {
    expect(() => extractListingArray({ success: false, status: 512, data: { items: [] } })).toThrow(/success.*512|512.*success/);
  });
});

describe('settle', () => {
  it('awaits a promise', async () => {
    await expect(settle(Promise.resolve({ a: 1 }), 1000)).resolves.toEqual({ a: 1 });
  });

  it('observes an observable once and unobserves it', async () => {
    const obs = observable({ success: true });
    await expect(settle(obs, 1000)).resolves.toEqual({ success: true });
    expect(obs.observe).toHaveBeenCalledTimes(1);
    expect(obs.unobserve).toHaveBeenCalled();
  });

  it('observes an observable a promise resolved to', async () => {
    await expect(settle(Promise.resolve(observable({ success: true, n: 2 })), 1000)).resolves.toEqual({ success: true, n: 2 });
  });

  it('rejects when an observable never calls back', async () => {
    await expect(settle(observable({}, false), 20)).rejects.toThrow(/did not call back/);
  });

  it('passes a plain value through', async () => {
    await expect(settle({ plain: true }, 1000)).resolves.toEqual({ plain: true });
  });
});
