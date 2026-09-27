// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Unit coverage for engine/assist.ts's keyboard-driven filter cycling and
// the governor gate on confirmBuy(), previously untested.

import { DEFAULT_ASSIST_HOTKEYS, type AssistHotkeys, type GovernorSettings } from '@sl/shared';
import { describe, expect, it, vi } from 'vitest';

import { AssistEngine, CONFIRM_TIMEOUT_MS, activeFilterHandles, type FilterHandle } from '../../src/engine/assist.js';
import { Governor } from '../../src/engine/governor.js';

import type { AdapterClient } from '../../src/content/adapter-client.js';
import type { ScoredOpportunity } from '../../src/engine/ranker.js';

const SETTINGS: GovernorSettings = {
  actionsPerHour: 30,
  sessionLengthMinutes: 90,
  buyToSearchRatio: 1,
  cooldownSeconds: 20,
  maxCoinFlowPerHour: 300_000,
};

function fakeAdapter(overrides: Partial<AdapterClient> = {}): AdapterClient {
  return {
    probeStatus: null,
    search: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    buy: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    readResult: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    diagnostics: vi.fn(async () => ({ ok: false, latencyMs: 0 })),
    onProbe: () => () => undefined,
    onShape: () => () => undefined,
    onBuyable: () => () => undefined,
    onTradePile: () => () => undefined,
    onAuctions: () => () => undefined,
    onCatalog: () => () => undefined,
    requestCatalog: () => undefined,
    dispose: () => undefined,
    ...overrides,
  };
}

function opportunity(overrides: Partial<ScoredOpportunity> = {}): ScoredOpportunity {
  return {
    resourceId: 1,
    tradeId: 'trade-1',
    price: 1000,
    summary: { floor: 900, median: 1100, max: 1300, sellThrough: 0.8, sampleSize: 20 } as unknown as ScoredOpportunity['summary'],
    ev: 100,
    netAtMedian: 100,
    probabilityOfSale: 0.8,
    ...overrides,
  };
}

/** The keydown a user's chord makes (`Alt+KeyB`, …). */
function press(chord: string, extra: { repeat?: boolean } = {}) {
  const parts = chord.split('+');
  const mods = new Set(parts.slice(0, -1));
  return {
    code: parts[parts.length - 1]!,
    key: '',
    altKey: mods.has('Alt'),
    ctrlKey: mods.has('Ctrl'),
    shiftKey: mods.has('Shift'),
    metaKey: mods.has('Meta'),
    ...extra,
  };
}
const K: AssistHotkeys = DEFAULT_ASSIST_HOTKEYS;

function makeEngine(
  overrides: Partial<{
    filters: FilterHandle[];
    ranked: ScoredOpportunity[];
    adapter: AdapterClient;
    canAct: () => boolean;
    now: () => number;
    hotkeys: AssistHotkeys;
  }> = {},
) {
  const filters = overrides.filters ?? [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }];
  const ranked = overrides.ranked ?? [opportunity()];
  const onFilterSelected = vi.fn();
  const onAttempt = vi.fn();
  const onTrade = vi.fn();
  const governor = new Governor(SETTINGS, { now: () => 0 });
  const adapter = overrides.adapter ?? fakeAdapter();

  const confirm = { show: vi.fn(), hide: vi.fn() };
  const engine = new AssistEngine({
    governor,
    adapter,
    getFilters: () => filters,
    getRanked: () => ranked,
    onFilterSelected,
    onAttempt,
    onTrade,
    confirm,
    ...(overrides.canAct ? { canAct: overrides.canAct } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.hotkeys ? { hotkeys: overrides.hotkeys } : {}),
  });

  return { engine, filters, ranked, onFilterSelected, onAttempt, onTrade, governor, adapter, confirm };
}

describe('AssistEngine keyboard cycling', () => {
  it('cycles forward through filters on nextFilter, wrapping around', () => {
    const { engine, filters, onFilterSelected } = makeEngine();

    expect(engine.handleKeydown(press(K.nextFilter))).toBe(true);
    expect(onFilterSelected).toHaveBeenNthCalledWith(1, filters[1]);
    expect(engine.activeFilter).toEqual(filters[1]);

    engine.handleKeydown(press(K.nextFilter));
    expect(onFilterSelected).toHaveBeenNthCalledWith(2, filters[2]);

    // Wraps back to the first filter.
    engine.handleKeydown(press(K.nextFilter));
    expect(onFilterSelected).toHaveBeenNthCalledWith(3, filters[0]);
  });

  it('cycles backward through filters on prevFilter, wrapping around', () => {
    const { engine, filters, onFilterSelected } = makeEngine();

    engine.handleKeydown(press(K.prevFilter));
    expect(onFilterSelected).toHaveBeenCalledWith(filters[2]); // wraps to the last filter
    expect(engine.activeFilter).toEqual(filters[2]);
  });

  it('is a no-op with zero filters (never selects, never throws)', () => {
    const { engine, onFilterSelected } = makeEngine({ filters: [] });
    expect(engine.handleKeydown(press(K.nextFilter))).toBe(true);
    expect(onFilterSelected).not.toHaveBeenCalled();
    expect(engine.activeFilter).toBeNull();
  });

  it('togglePause stops cycling until toggled again', () => {
    const { engine, onFilterSelected } = makeEngine();

    engine.handleKeydown(press(K.togglePause));
    expect(engine.isPaused).toBe(true);

    // While paused, cycle keys are not handled at all (false = not consumed).
    expect(engine.handleKeydown(press(K.nextFilter))).toBe(false);
    expect(onFilterSelected).not.toHaveBeenCalled();

    engine.handleKeydown(press(K.togglePause));
    expect(engine.isPaused).toBe(false);
    expect(engine.handleKeydown(press(K.nextFilter))).toBe(true);
    expect(onFilterSelected).toHaveBeenCalledTimes(1);
  });

  it('respects the hotkeys it is given', () => {
    const { engine, onFilterSelected } = makeEngine({ hotkeys: { ...K, nextFilter: 'Ctrl+Alt+KeyJ' } });

    // The old default no longer cycles...
    expect(engine.handleKeydown(press(K.nextFilter))).toBe(false);
    expect(onFilterSelected).not.toHaveBeenCalled();

    // ...the new binding does.
    expect(engine.handleKeydown(press('Ctrl+Alt+KeyJ'))).toBe(true);
    expect(onFilterSelected).toHaveBeenCalledTimes(1);
  });

  it('buy + confirm on the top-ranked candidate records a success attempt and updates session P&L', async () => {
    const { engine, onAttempt, onTrade } = makeEngine({ ranked: [opportunity({ price: 500, tradeId: 'trade-x' })] });

    engine.handleKeydown(press(K.buy));
    engine.handleKeydown(press(K.buy));
    await vi.waitFor(() => expect(onAttempt).toHaveBeenCalledTimes(1));

    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', tradeId: 'trade-x' }));
    expect(onTrade).toHaveBeenCalledWith(expect.objectContaining({ tradeId: 'trade-x', buyPrice: 500 }));
    expect(engine.sessionPnl).toEqual({ coinsSpent: 500, coinsEarned: 0, netProfit: -500, trades: 1 });
  });

  it('confirmBuy reports a blocked attempt (never calls adapter.buy) when the governor denies it', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const { engine, onAttempt, governor } = makeEngine({ adapter: fakeAdapter({ buy }) });
    governor.setKillSwitch(true, 'server kill switch');

    engine.handleKeydown(press(K.buy));
    engine.handleKeydown(press(K.buy));
    await vi.waitFor(() => expect(onAttempt).toHaveBeenCalledTimes(1));

    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', errorCode: 'kill_switch' }));
    expect(buy).not.toHaveBeenCalled();
    expect(engine.sessionPnl.trades).toBe(0);
  });

  it('confirmBuy while paused does nothing at all', async () => {
    const { engine, onAttempt } = makeEngine();
    engine.handleKeydown(press(K.togglePause));
    await engine.confirmBuy();
    expect(onAttempt).not.toHaveBeenCalled();
  });
});

describe('AssistEngine: what reaches EA, and what the governor charges', () => {
  it('skips a candidate the adapter cannot buy and takes the next one', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const { engine } = makeEngine({
      ranked: [opportunity({ tradeId: 'passive-only', buyable: false }), opportunity({ tradeId: 'buyable' })],
      adapter: fakeAdapter({ buy }),
    });
    await engine.confirmBuy();
    expect(buy).toHaveBeenCalledTimes(1);
    expect(buy).toHaveBeenCalledWith('buyable', 1000, { resourceId: 1 });
  });

  it.each(['price_mismatch', 'listing_unknown', 'listing_entity_unknown', 'adapter_unauthenticated'])(
    'refunds the governor when the adapter refuses with %s (the buy never reached EA)',
    async (error) => {
      const buy = vi.fn(async () => ({ ok: false, error, latencyMs: 1, signed: true as const }));
      const { engine, governor } = makeEngine({ adapter: fakeAdapter({ buy }) });
      governor.allow({ kind: 'search' });
      const before = governor.snapshot();
      await engine.confirmBuy();
      expect(governor.snapshot()).toEqual(before);
    },
  );

  it('never refunds a refusal the adapter did not sign (e.g. a timeout after a forged unready probe)', async () => {
    const buy = vi.fn(async () => ({ ok: false, error: 'adapter_unauthenticated', latencyMs: 15_000 }));
    const { engine, governor } = makeEngine({ adapter: fakeAdapter({ buy }) });
    governor.allow({ kind: 'search' });
    await engine.confirmBuy();
    expect(governor.snapshot().coinFlowLastHour).toBe(1000);
  });

  it('keeps the charge for a failure that did reach EA', async () => {
    const buy = vi.fn(async () => ({ ok: false, error: 'bid reported success: false (status 470)', latencyMs: 1 }));
    const { engine, governor } = makeEngine({ adapter: fakeAdapter({ buy }) });
    governor.allow({ kind: 'search' });
    await engine.confirmBuy();
    expect(governor.snapshot().coinFlowLastHour).toBe(1000);
  });

  it('records an unknown outcome on timeout_unknown, then the trade if the late answer says it went through', async () => {
    let resolveLate: (o: { ok: boolean; latencyMs: number }) => void = () => undefined;
    const late = new Promise<{ ok: boolean; latencyMs: number }>((r) => (resolveLate = r));
    const buy = vi.fn(async () => ({ ok: false, error: 'timeout_unknown', latencyMs: 12_000, late }));
    const { engine, onAttempt, onTrade, governor } = makeEngine({ adapter: fakeAdapter({ buy }) });
    governor.allow({ kind: 'search' });
    await engine.confirmBuy();
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'attempted', errorCode: 'timeout_unknown' }));
    expect(onTrade).not.toHaveBeenCalled();
    // Not refunded: it may well have gone through.
    expect(governor.snapshot().coinFlowLastHour).toBe(1000);

    resolveLate({ ok: true, latencyMs: 13_000 });
    await vi.waitFor(() => expect(onTrade).toHaveBeenCalledWith(expect.objectContaining({ tradeId: 'trade-1', buyPrice: 1000 })));
    expect(onAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'success', errorCode: null }));
    expect(engine.sessionPnl.trades).toBe(1);
  });
});

describe('AssistEngine: selection and the confirm step (P0 Task 13)', () => {
  const three = () => [
    opportunity({ tradeId: 't1', price: 1000 }),
    opportunity({ tradeId: 't2', price: 2000 }),
    opportunity({ tradeId: 't3', price: 3000 }),
  ];

  it('the buy chord only shows the confirm overlay; nothing is bought until it is pressed again', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const { engine, confirm } = makeEngine({ ranked: three(), adapter: fakeAdapter({ buy }) });
    expect(engine.handleKeydown(press(K.buy))).toBe(true);
    expect(confirm.show).toHaveBeenCalledWith(expect.objectContaining({ tradeId: 't1', price: 1000 }));
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();
    engine.handleKeydown(press(K.buy));
    await vi.waitFor(() => expect(buy).toHaveBeenCalledWith('t1', 1000, { resourceId: 1 }));
    expect(confirm.hide).toHaveBeenCalled();
  });

  it('Alt+Up/Down move the selection, and the buy names the selected listing', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const { engine, confirm } = makeEngine({ ranked: three(), adapter: fakeAdapter({ buy }) });
    expect(engine.selected()?.tradeId).toBe('t1');
    expect(engine.handleKeydown(press(K.selectDown))).toBe(true);
    engine.handleKeydown(press(K.selectDown));
    expect(engine.selected()?.tradeId).toBe('t3');
    engine.handleKeydown(press(K.selectUp));
    expect(engine.selected()?.tradeId).toBe('t2');
    engine.handleKeydown(press(K.buy));
    expect(confirm.show).toHaveBeenLastCalledWith(expect.objectContaining({ tradeId: 't2' }));
    engine.confirmPending();
    await vi.waitFor(() => expect(buy).toHaveBeenCalledWith('t2', 2000, { resourceId: 1 }));
  });

  it('Escape cancels the confirm step, and is left to EA (never consumed)', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const { engine, confirm } = makeEngine({ ranked: three(), adapter: fakeAdapter({ buy }) });
    engine.handleKeydown(press(K.buy));
    expect(engine.handleKeydown({ ...press('Escape'), key: 'Escape', altKey: false })).toBe(false);
    expect(confirm.hide).toHaveBeenCalled();
    engine.confirmPending();
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();
  });

  it('a held-down chord (key repeat) never confirms', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const { engine } = makeEngine({ ranked: three(), adapter: fakeAdapter({ buy }) });
    engine.handleKeydown(press(K.buy));
    engine.handleKeydown(press(K.buy, { repeat: true }));
    engine.handleKeydown(press(K.buy, { repeat: true }));
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();
    expect(engine.pendingTradeId).toBe('t1');
  });

  it('never buys a listing that has left the current search since the overlay opened', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    let ranked = three();
    const governor = new Governor(SETTINGS, { now: () => 0 });
    const engine = new AssistEngine({
      governor,
      adapter: fakeAdapter({ buy }),
      getFilters: () => [],
      getRanked: () => ranked,
      onFilterSelected: vi.fn(),
      onAttempt: vi.fn(),
      onTrade: vi.fn(),
    });
    engine.handleKeydown(press(K.buy)); // t1
    ranked = [opportunity({ tradeId: 't9' })]; // a new search replaced the listings
    engine.handleKeydown(press(K.buy));
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();
  });

  it('a confirm step left open too long expires', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    let now = 0;
    const { engine } = makeEngine({ ranked: three(), adapter: fakeAdapter({ buy }), now: () => now });
    engine.handleKeydown(press(K.buy));
    now = CONFIRM_TIMEOUT_MS + 1;
    engine.handleKeydown(press(K.buy));
    await Promise.resolve();
    expect(buy).not.toHaveBeenCalled();
  });

  it('does nothing in a tab that may not act (another EA tab holds the engine)', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const { engine, confirm } = makeEngine({ ranked: three(), adapter: fakeAdapter({ buy }), canAct: () => false });
    expect(engine.handleKeydown(press(K.buy))).toBe(false);
    expect(confirm.show).not.toHaveBeenCalled();
    await engine.confirmBuy();
    expect(buy).not.toHaveBeenCalled();
  });

  it('leaves every key that is not an assist chord alone', () => {
    const { engine, confirm, onFilterSelected } = makeEngine({ ranked: three() });
    for (const k of ['Enter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyB'])
      expect(engine.handleKeydown({ ...press(k), key: k })).toBe(false);
    expect(confirm.show).not.toHaveBeenCalled();
    expect(onFilterSelected).not.toHaveBeenCalled();
  });
});

describe('activeFilterHandles', () => {
  it('cycles only the filters the user left active, in their order', () => {
    expect(
      activeFilterHandles([
        { id: 'a', isActive: true },
        { id: 'b', isActive: false },
        { id: 'c', isActive: true },
      ]),
    ).toEqual([{ id: 'a' }, { id: 'c' }]);
  });
});
