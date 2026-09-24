// Unit coverage for main/shape-observable.ts on its own: the criteria
// builder's field mapping (every name an assumption from community
// autobuyers, docs/06-extension.md §4), the strict `success: true` rule, and
// a bid whose answer arrives after the adapter stopped waiting.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TimeoutUnknownError } from '../../src/main/ea-response.js';
import { createObservableShape, observableSearchCriteria } from '../../src/main/shape-observable.js';
import { itemEntity, observable, observableServices } from '../fixtures/ea-shapes.js';

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).UTSearchCriteriaDTO;
});

describe('observableSearchCriteria', () => {
  it("maps every filter field onto the web app's UTSearchCriteriaDTO names", () => {
    expect(
      observableSearchCriteria({
        resourceId: 7,
        minPrice: 100,
        maxPrice: 900,
        minRating: 84,
        maxRating: 86,
        position: 'ST',
        nationality: 18,
        league: 13,
        club: 10,
        quality: 'gold',
        rarity: 3,
        chemistryStyle: 250,
      }),
    ).toEqual({
      type: 'player',
      maskedDefId: 7,
      minBuy: 100,
      maxBuy: 900,
      ovrMin: 84,
      ovrMax: 86,
      position: 'ST',
      nation: 18,
      league: 13,
      club: 10,
      level: 'gold',
      rarities: [3],
      playStyle: 250,
    });
  });

  it('searches a position group as zone, instead of a single position', () => {
    const criteria = observableSearchCriteria({ position: 'ST', zone: 132 });
    expect(criteria).toMatchObject({ zone: 132 });
    expect(criteria).not.toHaveProperty('position');
  });

  it('maps the special quality to the special level', () => {
    expect(observableSearchCriteria({ quality: 'special' })).toMatchObject({ level: 'SP' });
  });

  it('refuses a field it cannot map rather than dropping it', () => {
    expect(() => observableSearchCriteria({ maxPrice: 900, playerRole: 3 } as never)).toThrow(/playerRole/);
  });

  it('fills an instance of the page\'s own criteria class when there is one', () => {
    class UTSearchCriteriaDTO {
      type = 'any';
      maxBuy = 0;
    }
    (window as unknown as Record<string, unknown>).UTSearchCriteriaDTO = UTSearchCriteriaDTO;
    const criteria = observableSearchCriteria({ maxPrice: 900 });
    expect(criteria).toBeInstanceOf(UTSearchCriteriaDTO);
    expect(criteria).toMatchObject({ type: 'player', maxBuy: 900 });
  });
});

describe('observable shape: search', () => {
  it('refuses a response with no success key, even with a list in it', async () => {
    const svc = observableServices();
    svc.searchTransferMarket.mockReturnValueOnce(observable({ data: { items: [] } }));
    await expect(createObservableShape(1000).search(svc.services, {})).rejects.toThrow(/success/);
  });
});

describe('observable shape: a bid answered after the timeout', () => {
  it('rejects with TimeoutUnknownError, then reports the late success', async () => {
    const svc = observableServices();
    const entity = itemEntity({ tradeId: 9, buyNowPrice: 500 });
    let callback: ((sender: unknown, response: unknown) => void) | undefined;
    svc.bid.mockReturnValueOnce({ observe: (_scope: unknown, cb: (sender: unknown, response: unknown) => void) => (callback = cb) });
    const onLate = vi.fn();

    await expect(createObservableShape(10).buy(svc.services, { tradeId: '9', price: 500, entity, onLate })).rejects.toBeInstanceOf(TimeoutUnknownError);
    callback!(null, { success: true });
    expect(onLate).toHaveBeenCalledWith(true);
  });

  it('reports a late failure as not bought', async () => {
    const svc = observableServices();
    let callback: ((sender: unknown, response: unknown) => void) | undefined;
    svc.bid.mockReturnValueOnce({ observe: (_scope: unknown, cb: (sender: unknown, response: unknown) => void) => (callback = cb) });
    const onLate = vi.fn();
    await expect(
      createObservableShape(10).buy(svc.services, { tradeId: '9', price: 500, entity: itemEntity({ tradeId: 9, buyNowPrice: 500 }), onLate }),
    ).rejects.toBeInstanceOf(TimeoutUnknownError);
    callback!(null, { success: false });
    expect(onLate).toHaveBeenCalledWith(false);
  });
});
