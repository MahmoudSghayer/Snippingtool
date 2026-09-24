// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Unit coverage for engine/autobuyer.ts, previously untested: it must stop
// immediately (mid-cycle, discarding remaining candidates) on a `shape`
// message from the adapter, and it must call governor.allow() before every
// single attempt, respecting a denial rather than acting anyway.

import { describe, expect, it, vi } from 'vitest';

import { Autobuyer } from '../../src/engine/autobuyer.js';
import { Governor } from '../../src/engine/governor.js';

import type { AdapterClient, ProbeStatus } from '../../src/content/adapter-client.js';
import type { ScoredOpportunity } from '../../src/engine/ranker.js';
import type { GovernorSettings } from '@sl/shared';

const SETTINGS: GovernorSettings = {
  actionsPerHour: 30,
  sessionLengthMinutes: 90,
  buyToSearchRatio: 1,
  cooldownSeconds: 20,
  maxCoinFlowPerHour: 300_000,
};

function opportunity(overrides: Partial<ScoredOpportunity> = {}): ScoredOpportunity {
  return {
    resourceId: 1,
    tradeId: 'trade-1',
    price: 1000,
    summary: {} as ScoredOpportunity['summary'],
    ev: 100,
    netAtMedian: 100,
    probabilityOfSale: 0.8,
    ...overrides,
  };
}

interface FakeAdapterHandle {
  adapter: AdapterClient;
  emitShape: (reason: string) => void;
  emitProbe: (status: ProbeStatus) => void;
}

function fakeAdapter(buyImpl: AdapterClient['buy'] = async () => ({ ok: true, latencyMs: 5 })): FakeAdapterHandle {
  let shapeCb: ((reason: string) => void) | undefined;
  let probeCb: ((status: ProbeStatus) => void) | undefined;

  const adapter: AdapterClient = {
    probeStatus: null,
    search: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    buy: buyImpl,
    readResult: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    diagnostics: vi.fn(async () => ({ ok: false, latencyMs: 0 })),
    onProbe: (cb) => {
      probeCb = cb;
      return () => {
        probeCb = undefined;
      };
    },
    onShape: (cb) => {
      shapeCb = cb;
      return () => {
        shapeCb = undefined;
      };
    },
    onBuyable: () => () => undefined,
    onAuctions: () => () => undefined,
    onCatalog: () => () => undefined,
    requestCatalog: () => undefined,
    dispose: () => undefined,
  };

  return {
    adapter,
    emitShape: (reason) => shapeCb?.(reason),
    emitProbe: (status) => probeCb?.(status),
  };
}

describe('Autobuyer: stops on shape mismatch', () => {
  it('a shape-mismatch signal mid-cycle stops immediately and discards remaining candidates', async () => {
    const candidates = [opportunity({ tradeId: 't-1' }), opportunity({ tradeId: 't-2' }), opportunity({ tradeId: 't-3' })];
    const onAttempt = vi.fn();
    const onTrade = vi.fn();
    const governor = new Governor(SETTINGS, { now: () => 0 });

    let calls = 0;
    const { adapter, emitShape } = fakeAdapter(async (tradeId) => {
      calls++;
      if (tradeId === 't-1') {
        // Simulate the adapter itself detecting a shape mismatch mid-buy and
        // firing its `onShape` callback before this promise resolves.
        emitShape('unexpected field on auction response');
        return { ok: true, latencyMs: 5 };
      }
      return { ok: true, latencyMs: 5 };
    });

    const autobuyer = new Autobuyer({ governor, adapter, onAttempt, onTrade });
    const successes = await autobuyer.runCycle(candidates);

    expect(autobuyer.isStopped()).toBe(true);
    expect(autobuyer.getStopReason()).toEqual({ reason: 'shape_mismatch', detail: 'unexpected field on auction response' });
    // Only the first candidate's buy() call ever fires — t-2/t-3 are discarded.
    expect(calls).toBe(1);
    expect(successes).toBe(1); // t-1 itself still completed (ok: true) before the stop was observed
    expect(onTrade).toHaveBeenCalledTimes(1);
  });

  it('a probe failure also stops the autobuyer, mid-cycle', async () => {
    const candidates = [opportunity({ tradeId: 't-1' }), opportunity({ tradeId: 't-2' })];
    const onAttempt = vi.fn();
    const onTrade = vi.fn();
    const governor = new Governor(SETTINGS, { now: () => 0 });
    const { adapter, emitProbe } = fakeAdapter();

    const autobuyer = new Autobuyer({ governor, adapter, onAttempt, onTrade });
    emitProbe({ ok: false, reason: 'bundle probe failed at load', checkedAt: Date.now() });

    const successes = await autobuyer.runCycle(candidates);
    expect(successes).toBe(0);
    expect(autobuyer.isStopped()).toBe(true);
    expect(autobuyer.getStopReason()?.reason).toBe('probe_failure');
    expect(onTrade).not.toHaveBeenCalled();
  });

  it('a stopped autobuyer never starts a new cycle', async () => {
    const governor = new Governor(SETTINGS, { now: () => 0 });
    const { adapter, emitShape } = fakeAdapter();
    const autobuyer = new Autobuyer({ governor, adapter, onAttempt: vi.fn(), onTrade: vi.fn() });

    emitShape('boom');
    expect(autobuyer.isStopped()).toBe(true);

    const successes = await autobuyer.runCycle([opportunity()]);
    expect(successes).toBe(0);
    expect(autobuyer.isRunning()).toBe(false);
  });
});

describe('Autobuyer: respects governor denial', () => {
  it('calls governor.allow() before every single attempt and reports a blocked attempt on denial, without calling adapter.buy', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const onAttempt = vi.fn();
    const onTrade = vi.fn();
    const governor = new Governor(SETTINGS, { now: () => 0 });
    governor.setKillSwitch(true, 'server kill switch');
    const { adapter } = fakeAdapter(buy);

    const autobuyer = new Autobuyer({ governor, adapter, onAttempt, onTrade });
    const successes = await autobuyer.runCycle([opportunity({ tradeId: 't-1' }), opportunity({ tradeId: 't-2' })]);

    expect(successes).toBe(0);
    expect(buy).not.toHaveBeenCalled();
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', errorCode: 'kill_switch' }));
    // Kill switch denies every action — the cycle breaks after the first denial rather than retrying each candidate.
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it('a soft-deny (buy:search ratio) skips only that candidate and continues the cycle', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const onAttempt = vi.fn();
    const onTrade = vi.fn();
    // buyToSearchRatio 0 with zero prior searches -> the very first buy already exceeds it (soft deny, not hard stop).
    const governor = new Governor({ ...SETTINGS, buyToSearchRatio: 0 }, { now: () => 0 });
    const { adapter } = fakeAdapter(buy);

    const autobuyer = new Autobuyer({ governor, adapter, onAttempt, onTrade });
    const successes = await autobuyer.runCycle([opportunity({ tradeId: 't-1' }), opportunity({ tradeId: 't-2' })]);

    // Both candidates denied (soft deny, cycle continues rather than breaking), buy() never called, 0 successes.
    expect(successes).toBe(0);
    expect(buy).not.toHaveBeenCalled();
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', errorCode: 'buy_search_ratio' }));
  });

  it('the session coin budget caps total spend independently of the governor, skipping candidates over budget', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    const governor = new Governor(SETTINGS, { now: () => 0 });
    const { adapter } = fakeAdapter(buy);

    const autobuyer = new Autobuyer({ governor, adapter, onAttempt: vi.fn(), onTrade: vi.fn(), sessionCoinBudget: 1000 });
    const successes = await autobuyer.runCycle([opportunity({ tradeId: 't-1', price: 800 }), opportunity({ tradeId: 't-2', price: 800 })]);

    // First buy (800) fits under the 1000 budget; the second (would bring total to 1600) is skipped.
    expect(successes).toBe(1);
    expect(buy).toHaveBeenCalledTimes(1);
  });
});

describe('Autobuyer: adapter refusals are failed attempts, not retries (defect C12)', () => {
  it.each(['price_mismatch', 'listing_unknown', 'listing_entity_unknown', 'adapter_unauthenticated'])(
    'a %s refusal is recorded once as failed, with no trade and no retry',
    async (error) => {
      const onAttempt = vi.fn();
      const onTrade = vi.fn();
      const governor = new Governor(SETTINGS, { now: () => 0 });
      const buy = vi.fn(async () => ({ ok: false, error, latencyMs: 1 }));
      const { adapter } = fakeAdapter(buy);

      const autobuyer = new Autobuyer({ governor, adapter, onAttempt, onTrade, maxRetriesPerCandidate: 2 });
      const successes = await autobuyer.runCycle([opportunity({ tradeId: 't-1' })]);

      expect(successes).toBe(0);
      expect(buy).toHaveBeenCalledTimes(1);
      expect(onTrade).not.toHaveBeenCalled();
      expect(onAttempt).toHaveBeenCalledTimes(1);
      expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', errorCode: error }));
    },
  );
});

describe('Autobuyer: what reaches EA, and what the governor charges', () => {
  it('refunds the governor for an adapter refusal', async () => {
    const governor = new Governor(SETTINGS, { now: () => 0 });
    governor.allow({ kind: 'search' });
    const before = governor.snapshot();
    const { adapter } = fakeAdapter(vi.fn(async () => ({ ok: false, error: 'price_mismatch', latencyMs: 1, signed: true as const })));
    await new Autobuyer({ governor, adapter, onAttempt: vi.fn(), onTrade: vi.fn() }).runCycle([opportunity()]);
    expect(governor.snapshot()).toEqual(before);
  });

  it('never refunds an unsigned adapter_unauthenticated (a forged probe plus a timeout)', async () => {
    const governor = new Governor(SETTINGS, { now: () => 0 });
    governor.allow({ kind: 'search' });
    const { adapter } = fakeAdapter(vi.fn(async () => ({ ok: false, error: 'adapter_unauthenticated', latencyMs: 15_000 })));
    await new Autobuyer({ governor, adapter, onAttempt: vi.fn(), onTrade: vi.fn() }).runCycle([opportunity()]);
    expect(governor.serialize().buyCount).toBe(1);
    expect(governor.snapshot().coinFlowLastHour).toBe(1000);
  });

  it('never attempts a listing the adapter cannot buy', async () => {
    const buy = vi.fn(async () => ({ ok: true, latencyMs: 1 }));
    const { adapter } = fakeAdapter(buy);
    const onAttempt = vi.fn();
    const governor = new Governor(SETTINGS, { now: () => 0 });
    await new Autobuyer({ governor, adapter, onAttempt, onTrade: vi.fn() }).runCycle([opportunity({ tradeId: 'x', buyable: false })]);
    expect(buy).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
    expect(governor.serialize().buyCount).toBe(0);
  });

  it('never retries a timeout_unknown buy (it may have gone through), and counts a late success', async () => {
    let resolveLate: (o: { ok: boolean; latencyMs: number }) => void = () => undefined;
    const late = new Promise<{ ok: boolean; latencyMs: number }>((r) => (resolveLate = r));
    const buy = vi.fn(async () => ({ ok: false, error: 'timeout_unknown', latencyMs: 12_000, late }));
    const { adapter } = fakeAdapter(buy);
    const onAttempt = vi.fn();
    const onTrade = vi.fn();
    const governor = new Governor(SETTINGS, { now: () => 0 });
    const autobuyer = new Autobuyer({ governor, adapter, onAttempt, onTrade, maxRetriesPerCandidate: 2, sessionCoinBudget: 1500 });
    expect(await autobuyer.runCycle([opportunity({ price: 1000 })])).toBe(0);
    expect(buy).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'attempted', errorCode: 'timeout_unknown' }));

    resolveLate({ ok: true, latencyMs: 13_000 });
    await vi.waitFor(() => expect(onTrade).toHaveBeenCalledTimes(1));
    // The late buy counts against the session budget: a second 1000 no longer fits.
    const buy2 = vi.fn(async () => ({ ok: true, latencyMs: 1 }));
    (adapter as { buy: unknown }).buy = buy2;
    await autobuyer.runCycle([opportunity({ tradeId: 't-2', price: 1000 })]);
    expect(buy2).not.toHaveBeenCalled();
  });
});
