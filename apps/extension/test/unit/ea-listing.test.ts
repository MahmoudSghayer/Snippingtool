// Unit coverage for the adapter's shape-independent response handling
// (main/ea-response.ts, main/ea-listing.ts): whatever a service-layer call
// hands back — a Promise, an observable, a UTAS JSON envelope or a list of
// item entities — either becomes a list of normalised listings or an error.
// Never an `ok` with nothing in it because the envelope was not understood.

import { describe, expect, it, vi } from 'vitest';

import { normaliseListing, normaliseListings, normalisePileItem, normalisePileItems } from '../../src/main/ea-listing.js';
import { ShapeError, TimeoutUnknownError, describeError, extractListingArray, settle } from '../../src/main/ea-response.js';
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
    ['only an assetId for a card id (not a resourceId)', { tradeId: 1, buyNowPrice: 100, itemData: { assetId: 5 } }],
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

  it('reports how many unreadable entries it skipped', () => {
    const onSkipped = vi.fn();
    normaliseListings([utasAuction({ tradeId: 1, buyNowPrice: 1 }), { junk: true }, 'junk'], onSkipped);
    expect(onSkipped).toHaveBeenCalledWith(2);
    const quiet = vi.fn();
    normaliseListings([utasAuction({ tradeId: 1, buyNowPrice: 1 })], quiet);
    expect(quiet).not.toHaveBeenCalled();
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

  it('accepts a list with no success key by default, and refuses it when success is required', () => {
    expect(extractListingArray({ data: { items: [] } })).toEqual([]);
    expect(() => extractListingArray({ data: { items: [] } }, { requireSuccess: true })).toThrow(/success/);
    expect(extractListingArray({ success: true, data: { items: [] } }, { requireSuccess: true })).toEqual([]);
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

  it('rejects when a promise never settles', async () => {
    await expect(settle(new Promise(() => undefined), 20)).rejects.toThrow(/did not settle/);
  });

  it('shares one deadline between a promise and the observable it resolves to', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve(observable({ ok: 1 }, false)), 15));
    const started = Date.now();
    await expect(settle(slow, 30)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('reports a late observable callback through onLate, after rejecting with TimeoutUnknownError', async () => {
    let callback: ((sender: unknown, response: unknown) => void) | undefined;
    const late = { observe: (_scope: unknown, cb: (sender: unknown, response: unknown) => void) => (callback = cb), unobserve: vi.fn() };
    const onLate = vi.fn();
    await expect(settle(late, 10, onLate)).rejects.toBeInstanceOf(TimeoutUnknownError);
    callback!(late, { success: true });
    expect(onLate).toHaveBeenCalledWith({ success: true });
    expect(late.unobserve).toHaveBeenCalled();
  });

  it('observes an observable a timed-out promise resolves to late, and hands onLate its response', async () => {
    const onLate = vi.fn();
    const slow = new Promise((resolve) => setTimeout(() => resolve(observable({ success: false })), 20));
    await expect(settle(slow, 5, onLate)).rejects.toBeInstanceOf(TimeoutUnknownError);
    await vi.waitFor(() => expect(onLate).toHaveBeenCalledWith({ success: false }));
    expect(onLate).toHaveBeenCalledTimes(1);
  });

  it('passes a plain value through', async () => {
    await expect(settle({ plain: true }, 1000)).resolves.toEqual({ plain: true });
  });
});

describe('describeError', () => {
  it('keeps the adapter\'s own messages', () => {
    expect(describeError(new ShapeError('search response has no list'))).toBe('search response has no list');
  });

  it('never repeats the text of an error EA\'s code threw', () => {
    const text = describeError(Object.assign(new TypeError('coins 7654321 for someone@example.com'), { code: 'E_BUSY', status: 461 }));
    expect(text).not.toContain('7654321');
    expect(text).not.toContain('example.com');
    expect(text).toContain('TypeError');
    expect(text).toContain('461');
    expect(text).toContain('E_BUSY');
  });

  it('describes a non-Error rejection by its allowlisted fields only', () => {
    expect(describeError({ success: false, status: 470, credits: 7654321 })).toMatch(/success: false.*470|470.*success: false/);
    expect(describeError({ success: false, status: 470, credits: 7654321 })).not.toContain('7654321');
    expect(describeError('free text 7654321')).not.toContain('7654321');
  });
});

// Trade pile (defect C13): the trader's own items, read passively. The
// UTAS shape below is the assumed one (docs/06-extension.md, day-one
// checklist): `auctionInfo` entries whose `itemData.id` is the item's own
// id, `tradeState` null while the card sits on the pile unlisted.
function pileEntry(fields: { tradeId?: number | null; itemId?: number; tradeState?: string | null; currentBid?: number; buyNowPrice?: number; rating?: number }) {
  return {
    tradeId: fields.tradeId === undefined ? 7001 : fields.tradeId,
    buyNowPrice: fields.buyNowPrice ?? 14_000,
    startingBid: 13_000,
    currentBid: fields.currentBid ?? 0,
    offers: 0,
    expires: 3600,
    tradeState: fields.tradeState === undefined ? 'active' : fields.tradeState,
    itemData: { id: fields.itemId ?? 900_001, resourceId: 50_331_700, assetId: 231_747, rating: fields.rating ?? 88 },
  };
}

describe('normaliseListing itemId', () => {
  it('reads the item id from itemData.id, and from an entity id', () => {
    expect(normaliseListing({ ...utasAuction({ tradeId: 1, buyNowPrice: 900 }), itemData: { id: 123456, resourceId: 7, assetId: 7, rating: 84 } })?.itemId).toBe('123456');
    const entity = itemEntity({ tradeId: 2, buyNowPrice: 1200, resourceId: 8 }, { accessor: 'field' }) as Record<string, unknown>;
    entity.id = 654321;
    expect(normaliseListing(entity)?.itemId).toBe('654321');
  });

  it('leaves itemId unset when there is none', () => {
    expect(normaliseListing(utasAuction({ tradeId: 1, buyNowPrice: 900 }))?.itemId).toBeUndefined();
  });
});

describe('normalisePileItem', () => {
  it('reads a listed, a sold and an expired item', () => {
    expect(normalisePileItem(pileEntry({}))).toEqual({
      itemId: '900001',
      tradeId: '7001',
      resourceId: 50_331_700,
      rating: 88,
      tradeState: 'active',
      currentBid: 0,
      buyNowPrice: 14_000,
      expires: 3600,
    });
    expect(normalisePileItem(pileEntry({ tradeState: 'closed', currentBid: 13_500 }))).toMatchObject({ tradeState: 'closed', currentBid: 13_500 });
    expect(normalisePileItem(pileEntry({ tradeState: 'expired' }))).toMatchObject({ tradeState: 'expired' });
  });

  it('reads an unlisted item (no trade, no state)', () => {
    expect(normalisePileItem(pileEntry({ tradeId: 0, tradeState: null }))).toMatchObject({ tradeId: null, tradeState: null });
  });

  it('rejects an item with no item id, or a state it does not know', () => {
    const noId = pileEntry({});
    delete (noId.itemData as { id?: number }).id;
    expect(normalisePileItem(noId)).toBeNull();
    expect(normalisePileItem(pileEntry({ tradeState: 'pending' }))).toBeNull();
  });

  it('throws when not one entry of a non-empty pile can be read, and counts skipped ones', () => {
    expect(() => normalisePileItems([{}, { itemData: {} }])).toThrow(ShapeError);
    const onSkipped = vi.fn();
    expect(normalisePileItems([pileEntry({}), {}], onSkipped)).toHaveLength(1);
    expect(onSkipped).toHaveBeenCalledWith(1);
    expect(normalisePileItems([])).toEqual([]);
  });
});
