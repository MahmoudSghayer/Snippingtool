// Assist-mode flow against the real Governor under DEFAULT_GOVERNOR_SETTINGS
// (defect C1): the human clicks Search in EA's UI, the adapter reports each
// response (twice — see engine/search.ts), and the confirm key buys. Before
// the fix no search ever reached the governor, so every buy after the first
// was denied `buy_search_ratio`.
import { DEFAULT_GOVERNOR_SETTINGS } from '@sl/shared';
import { describe, expect, it, vi } from 'vitest';

import { AssistEngine } from '../../src/engine/assist.js';
import { Governor } from '../../src/engine/governor.js';
import { countObservedSearches, governedSearch } from '../../src/engine/search.js';

import type { ActionOutcome, AdapterClient } from '../../src/content/adapter-client.js';
import type { ScoredOpportunity } from '../../src/engine/ranker.js';

const START = 1_700_000_000_000;

function fakeAdapter(clock: { now: number }) {
  const auctionListeners = new Set<(auctions: unknown[]) => void>();
  const emitSearchResponse = () => {
    // One search, reported twice: the patched XHR and emitAuctionInfo.
    for (const cb of auctionListeners) cb([{ tradeId: 't' }]);
    for (const cb of auctionListeners) cb([{ tradeId: 't' }]);
  };
  const adapter: AdapterClient = {
    probeStatus: null,
    // An engine-issued search that takes a while (longer than the dedupe
    // window) and reports its response before resolving, as adapter.ts does.
    search: vi.fn(async (): Promise<ActionOutcome> => {
      clock.now += 5_000;
      emitSearchResponse();
      return { ok: true, latencyMs: 5_000 };
    }),
    buy: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    readResult: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    onProbe: () => () => undefined,
    onShape: () => () => undefined,
    onAuctions: (cb) => {
      auctionListeners.add(cb);
      return () => auctionListeners.delete(cb);
    },
    dispose: () => undefined,
  };
  return { adapter, emitSearchResponse };
}

function opportunity(tradeId: string): ScoredOpportunity {
  return {
    resourceId: 1,
    tradeId,
    price: 10_000,
    summary: {} as ScoredOpportunity['summary'],
    ev: 100,
    netAtMedian: 100,
    probabilityOfSale: 0.8,
  };
}

function setup() {
  const clock = { now: START };
  const governor = new Governor(DEFAULT_GOVERNOR_SETTINGS, { now: () => clock.now });
  const { adapter, emitSearchResponse } = fakeAdapter(clock);
  countObservedSearches(adapter, () => governor);
  let ranked: ScoredOpportunity[] = [];
  const onAttempt = vi.fn();
  const engine = new AssistEngine({
    governor,
    adapter,
    getFilters: () => [{ id: 'f1' }],
    getRanked: () => ranked,
    onFilterSelected: () => undefined,
    onAttempt,
    onTrade: vi.fn(),
  });
  const humanSearch = () => {
    clock.now += 15_000;
    emitSearchResponse();
  };
  return { clock, governor, adapter, engine, onAttempt, humanSearch, setRanked: (r: ScoredOpportunity[]) => (ranked = r) };
}

describe('assist flow — observed searches keep buys allowed', () => {
  it('allows more than one buy after the human searches in EA', async () => {
    const { engine, adapter, onAttempt, humanSearch, setRanked } = setup();

    for (let buy = 1; buy <= 3; buy++) {
      humanSearch();
      humanSearch();
      humanSearch();
      setRanked([opportunity(`trade-${buy}`)]);
      await engine.confirmBuy();
    }

    expect(adapter.buy).toHaveBeenCalledTimes(3);
    expect(onAttempt.mock.calls.map((c) => c[0].outcome)).toEqual(['success', 'success', 'success']);
  });

  it('counts each double-reported search once', () => {
    const { governor, humanSearch } = setup();
    humanSearch();
    humanSearch();
    expect(governor.snapshot().actionsLastHour).toBe(2);
  });
});

describe('governedSearch — engine-issued searches go through the governor', () => {
  it('counts an allowed search once, even though its response is also observed', async () => {
    const { governor, adapter } = setup();
    const result = await governedSearch(governor, adapter, { resourceId: 1 });
    expect(result.searched).toBe(true);
    expect(adapter.search).toHaveBeenCalledTimes(1);
    expect(governor.snapshot().actionsLastHour).toBe(1);
  });

  it('skips the search (and does not throw) when the governor denies it', async () => {
    const { governor, adapter } = setup();
    governor.setKillSwitch(true, 'stop');
    const result = await governedSearch(governor, adapter, { resourceId: 1 });
    expect(result.searched).toBe(false);
    expect(result.decision.reason).toBe('kill_switch');
    expect(adapter.search).not.toHaveBeenCalled();
  });

  it('releases the in-flight marker even if the adapter call rejects', async () => {
    const { governor, adapter, clock, humanSearch } = setup();
    adapter.search = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(governedSearch(governor, adapter, { resourceId: 1 })).rejects.toThrow('boom');
    clock.now += 60_000;
    humanSearch();
    expect(governor.snapshot().actionsLastHour).toBe(2);
  });
});
