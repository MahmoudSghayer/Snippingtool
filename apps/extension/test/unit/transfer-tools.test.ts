// The Nova AI page's Transfer list card buttons (content/transfer-tools.ts):
// Clear sold through EA's own Clear Sold; Relist unsold at the same prices
// through EA's own Re-list All (one request), or a price step lower or
// higher, one card at a time with a few seconds between, from each card's
// last buy-now price, the starting bid a step under it.

import { describe, expect, it, vi } from 'vitest';

import { MAX_REFUSED_IN_A_ROW, RELIST_GAP_MS, clearSold, relistPrices, relistUnsold, type TransferToolsDeps } from '../../src/content/transfer-tools.js';

import type { ActionOutcome } from '../../src/content/adapter-client.js';
import type { TradePileItem } from '@sl/shared';

const unsoldCard = (itemId: string, buyNowPrice: number): TradePileItem => ({
  itemId,
  tradeId: `9${itemId}`,
  resourceId: 20801,
  rating: 86,
  tradeState: 'expired',
  currentBid: 0,
  buyNowPrice,
  expires: 0,
});

const ok = (extra: Partial<ActionOutcome> = {}): ActionOutcome => ({ ok: true, latencyMs: 5, ...extra });
const refused = (error: string): ActionOutcome => ({ ok: false, error, signed: true, latencyMs: 5 });

function setup(unsold: TradePileItem[] = [], relist: (itemId: string) => ActionOutcome = () => ok()) {
  const events: string[] = [];
  const adapter = {
    clearSold: vi.fn(async () => ok()),
    relistAll: vi.fn(async () => ok()),
    unsold: vi.fn(async () => ok({ unsold })),
    relist: vi.fn(async (itemId: string, start: number, bin: number) => {
      events.push(`relist ${itemId} ${start}/${bin}`);
      return relist(itemId);
    }),
  };
  const deps: TransferToolsDeps = {
    adapter,
    sleep: vi.fn(async (ms: number) => {
      events.push(`wait ${ms}`);
    }),
    random: () => 0.5,
  };
  return { adapter, deps, events };
}

describe('relist prices', () => {
  it("move the buy-now price one step of EA's grid, the starting bid one step under it", () => {
    expect(relistPrices(2_100, -1)).toEqual({ startPrice: 1_900, buyNowPrice: 2_000 });
    expect(relistPrices(2_100, 1)).toEqual({ startPrice: 2_100, buyNowPrice: 2_200 });
    // Across a band edge, as EA's own price arrows move.
    expect(relistPrices(10_000, 1)).toEqual({ startPrice: 10_000, buyNowPrice: 10_250 });
    expect(relistPrices(1_000, -1)).toEqual({ startPrice: 900, buyNowPrice: 950 });
  });

  it("never go under EA's lowest buy-now price", () => {
    expect(relistPrices(200, -1)).toEqual({ startPrice: 150, buyNowPrice: 200 });
  });

  it('never step a buy-now price below a break-even floor', () => {
    // A 48,000 listing would step down to 47,750, but a floor of 48,750
    // (break-even on a 46,250 card after EA's tax) holds it there instead.
    expect(relistPrices(48_000, -1, 48_750)).toEqual({ startPrice: 48_500, buyNowPrice: 48_750 });
    // A floor at or under the stepped price does nothing.
    expect(relistPrices(2_100, -1, 1_000)).toEqual({ startPrice: 1_900, buyNowPrice: 2_000 });
  });
});

describe('Clear sold', () => {
  it("uses EA's own Clear Sold and says how many cards went", async () => {
    const { adapter, deps } = setup();
    expect(await clearSold(deps, 5)).toEqual({ ok: true, message: 'Cleared 5 sold cards' });
    expect(adapter.clearSold).toHaveBeenCalledTimes(1);
  });

  it('says why when EA did not clear them', async () => {
    const { adapter, deps } = setup();
    adapter.clearSold.mockResolvedValueOnce(refused('window.services.Item.clearSoldItems is not a function'));
    expect(await clearSold(deps, 2)).toEqual({ ok: false, message: "Sold cards not cleared: EA's page has no such call here (reload EA and try again)" });
  });
});

describe('Relist unsold', () => {
  it("at the same prices is EA's own Re-list All: one request, no card read", async () => {
    const { adapter, deps } = setup([unsoldCard('1', 2_100)]);
    expect(await relistUnsold(deps, 0)).toEqual({ ok: true, message: 'Relisted the unsold cards at the same prices' });
    expect(adapter.relistAll).toHaveBeenCalledTimes(1);
    expect(adapter.unsold).not.toHaveBeenCalled();
    expect(adapter.relist).not.toHaveBeenCalled();
  });

  it('a step lower lists each unsold card again, one at a time with a pause between, and says how far it got', async () => {
    const { adapter, deps, events } = setup([unsoldCard('1', 2_100), unsoldCard('2', 12_000), unsoldCard('3', 900)]);
    const progress: string[] = [];
    const result = await relistUnsold(deps, -1, (done, total) => progress.push(`${done}/${total}`));
    expect(result).toEqual({ ok: true, message: 'Relisted 3 of 3 unsold cards one step lower' });
    expect(adapter.unsold).toHaveBeenCalledTimes(1);
    const gap = Math.round((RELIST_GAP_MS[0] + RELIST_GAP_MS[1]) / 2);
    expect(events).toEqual([`relist 1 1900/2000`, `wait ${gap}`, `relist 2 11500/11750`, `wait ${gap}`, `relist 3 800/850`]);
    expect(progress).toEqual(['1/3', '2/3', '3/3']);
  });

  it('floors a step-lower relist at break-even, so a card is never relisted under what it cost', async () => {
    const { deps, events } = setup([unsoldCard('1', 48_000), unsoldCard('2', 2_100)]);
    // Card 1 cost 46,250 (break-even 48,750 after EA's 5% tax); card 2 has no
    // record (bought before the lifecycle), so it steps lower as before.
    deps.costOf = vi.fn(async () => ({ '1': 46_250 }));
    const result = await relistUnsold(deps, -1);
    expect(deps.costOf).toHaveBeenCalledWith(['1', '2']);
    expect(events[0]).toBe('relist 1 48500/48750');
    expect(events.at(-1)).toBe('relist 2 1900/2000');
    expect(result.message).toContain('1 kept at break-even');
  });

  it('a step higher too', async () => {
    const { deps, events } = setup([unsoldCard('1', 2_100)]);
    expect((await relistUnsold(deps, 1)).message).toBe('Relisted 1 of 1 unsold card one step higher');
    expect(events).toEqual(['relist 1 2100/2200']);
  });

  it('says which cards EA refused, and stops once it refused several in a row', async () => {
    const cards = Array.from({ length: 6 }, (_, i) => unsoldCard(String(i + 1), 2_000));
    const { adapter, deps } = setup(cards, (itemId) => (itemId === '1' ? ok() : refused('list reported success: false (status 460)')));
    const result = await relistUnsold(deps, -1);
    expect(adapter.relist).toHaveBeenCalledTimes(1 + MAX_REFUSED_IN_A_ROW);
    expect(result).toEqual({
      ok: false,
      message: `Relisted 1 of 6 unsold cards one step lower; EA refused 3: list reported success: false (status 460); stopped after ${MAX_REFUSED_IN_A_ROW} refusals in a row`,
    });
  });

  it('leaves a card listed without a buy-now price as it is, and says when there is nothing to relist', async () => {
    const { adapter, deps } = setup([unsoldCard('1', 2_100), unsoldCard('2', 0)]);
    expect((await relistUnsold(deps, -1)).message).toBe('Relisted 1 of 1 unsold card one step lower; 1 card without a buy-now price left as it is');
    expect(adapter.relist).toHaveBeenCalledTimes(1);

    const empty = setup([]);
    expect(await relistUnsold(empty.deps, 1)).toEqual({ ok: true, message: 'No unsold cards to relist' });
  });

  it('says so when it cannot read the transfer list', async () => {
    const { adapter, deps } = setup();
    adapter.unsold.mockResolvedValueOnce(refused('timed out waiting for adapter response'));
    expect(await relistUnsold(deps, -1)).toEqual({ ok: false, message: 'Could not read your transfer list: EA did not answer in time' });
    expect(adapter.relist).not.toHaveBeenCalled();
  });
});
