// The per-profile engine lease (P0 Task 13, item 5): two EA tabs used to run
// two engines, each with its own copy of the governor's hourly windows (and
// of the Sniping Bot's), so two tabs could spend twice the hourly budget.
// Now background keeps one lease per browser profile (`storage.session`),
// only the tab holding it runs an engine, and a tab that gains it first
// loads the budgets the previous holder saved.
//
// The same handlers serve the userscript, where every EA tab runs its own
// copy of "background" over one shared Tampermonkey store: with one tab the
// lease is simply always free.

import { DEFAULT_GOVERNOR_SETTINGS } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENGINE_LEASE_MS,
  currentEngineState,
  handleEngineLockAcquire,
  handleEngineLockRelease,
  handleEngineState,
} from '../../src/background/engine-lease.js';
import { handleEngineStateGet, handleEngineStateSet } from '../../src/background/governor.js';
import { EngineLease } from '../../src/content/engine-lease.js';
import { Governor } from '../../src/engine/governor.js';

import { useRealChromeStorage } from './chrome-storage-stub.js';

const A = '0b3c6a52-5a4e-4c55-8f0a-4b8c0e1f0a01';
const B = '0b3c6a52-5a4e-4c55-8f0a-4b8c0e1f0a02';
const START = 1_700_000_000_000;

describe('background/engine-lease.ts', () => {
  useRealChromeStorage();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });
  afterEach(() => vi.useRealTimers());

  it('gives the lease to one tab at a time, and to the next once it is released', async () => {
    expect(await handleEngineLockAcquire({ ownerId: A })).toEqual({ held: true, expiresAt: START + ENGINE_LEASE_MS });
    expect((await handleEngineLockAcquire({ ownerId: B })).held).toBe(false);
    // Renewing extends the holder's lease.
    vi.setSystemTime(START + 10_000);
    expect(await handleEngineLockAcquire({ ownerId: A })).toEqual({ held: true, expiresAt: START + 10_000 + ENGINE_LEASE_MS });
    // Only the holder can release it.
    await handleEngineLockRelease({ ownerId: B });
    expect((await handleEngineLockAcquire({ ownerId: B })).held).toBe(false);
    await handleEngineLockRelease({ ownerId: A });
    expect((await handleEngineLockAcquire({ ownerId: B })).held).toBe(true);
  });

  it('lets another tab take a lease its holder stopped renewing (a crashed tab)', async () => {
    await handleEngineLockAcquire({ ownerId: A });
    vi.setSystemTime(START + ENGINE_LEASE_MS - 1);
    expect((await handleEngineLockAcquire({ ownerId: B })).held).toBe(false);
    vi.setSystemTime(START + ENGINE_LEASE_MS + 1);
    expect((await handleEngineLockAcquire({ ownerId: B })).held).toBe(true);
  });

  it('answers two acquires arriving together with one holder', async () => {
    const [a, b] = await Promise.all([handleEngineLockAcquire({ ownerId: A }), handleEngineLockAcquire({ ownerId: B })]);
    expect([a.held, b.held].filter(Boolean)).toHaveLength(1);
  });

  it('keeps the live engine state for the heartbeat, and reports idle once it is stale', async () => {
    expect(await currentEngineState()).toBe('idle');
    await handleEngineState({ engineState: 'running' });
    expect(await currentEngineState()).toBe('running');
    vi.setSystemTime(START + ENGINE_LEASE_MS + 1);
    expect(await currentEngineState()).toBe('idle');
  });
});

describe('content/engine-lease.ts', () => {
  function tab(
    ownerId: string,
    backend: {
      acquire: (id: string) => Promise<{ held: boolean; expiresAt: number } | null>;
      release: (id: string) => void;
    },
    opts: { now: () => number; onGain?: () => Promise<boolean>; onLose?: () => void },
  ) {
    return new EngineLease({ ownerId, ...backend, ...opts });
  }

  it('counts as held only after onGain has loaded the budgets', async () => {
    let clock = START;
    let gained = false;
    const lease = tab(
      A,
      { acquire: async () => ({ held: true, expiresAt: clock + ENGINE_LEASE_MS }), release: () => undefined },
      {
        now: () => clock,
        onGain: async () => {
          expect(lease.isHeld()).toBe(false);
          gained = true;
          return true;
        },
      },
    );
    expect(lease.isHeld()).toBe(false);
    expect(await lease.refresh()).toBe(true);
    expect(gained).toBe(true);
    expect(lease.isHeld()).toBe(true);
    clock += 1;
  });

  it('gives the lease straight back when the budgets could not be loaded (fail closed)', async () => {
    const release = vi.fn();
    const lease = tab(
      A,
      { acquire: async () => ({ held: true, expiresAt: START + ENGINE_LEASE_MS }), release },
      { now: () => START, onGain: async () => false },
    );
    expect(await lease.refresh()).toBe(false);
    expect(lease.isHeld()).toBe(false);
    expect(release).toHaveBeenCalledWith(A);
  });

  it('with background unreachable, a holder keeps only what its stored lease still guarantees', async () => {
    let clock = START;
    let answer: { held: boolean; expiresAt: number } | null = { held: true, expiresAt: START + ENGINE_LEASE_MS };
    const onLose = vi.fn();
    const lease = tab(A, { acquire: async () => answer, release: () => undefined }, { now: () => clock, onLose });
    await lease.refresh();
    answer = null; // the service worker is restarting
    clock = START + 60_000;
    expect(await lease.refresh()).toBe(true);
    clock = START + ENGINE_LEASE_MS;
    expect(await lease.refresh()).toBe(false);
    expect(lease.isHeld()).toBe(false);
    expect(onLose).toHaveBeenCalledTimes(1);
  });

  it('a tab that never held it does not start holding it when background is unreachable', async () => {
    const lease = tab(A, { acquire: async () => null, release: () => undefined }, { now: () => START });
    expect(await lease.refresh()).toBe(false);
  });

  it('stops counting as held at its own expiry even without a refresh', async () => {
    let clock = START;
    const lease = tab(A, { acquire: async () => ({ held: true, expiresAt: START + ENGINE_LEASE_MS }), release: () => undefined }, { now: () => clock });
    await lease.refresh();
    clock = START + ENGINE_LEASE_MS;
    expect(lease.isHeld()).toBe(false);
  });

  it('tells the tab when another took the lease over', async () => {
    let answer = { held: true, expiresAt: START + ENGINE_LEASE_MS };
    const onLose = vi.fn();
    const lease = tab(A, { acquire: async () => answer, release: () => undefined }, { now: () => START, onLose });
    await lease.refresh();
    answer = { held: false, expiresAt: START + 2 * ENGINE_LEASE_MS };
    expect(await lease.refresh()).toBe(false);
    expect(onLose).toHaveBeenCalledTimes(1);
  });
});

describe('two EA tabs share one assist governor budget (multi-tab budget)', () => {
  useRealChromeStorage();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });
  afterEach(() => vi.useRealTimers());

  const settings = { ...DEFAULT_GOVERNOR_SETTINGS, actionsPerHour: 4, buyToSearchRatio: 1, maxCoinFlowPerHour: 1_000_000 };

  /** One EA tab as content/index.ts wires it: a governor loaded at page
   * load, and the lease, whose onGain re-loads what the last holder saved. */
  async function openTab(ownerId: string) {
    const saved = await handleEngineStateGet();
    const t = {
      governor: saved ? Governor.hydrate(settings, saved) : new Governor(settings),
      lease: null as unknown as EngineLease,
      /** An engine action, as the assist hotkeys and the autobuyer take one. */
      act(kind: 'search' | 'buy'): boolean {
        if (!t.lease.isHeld()) return false;
        const decision = t.governor.allow(kind === 'buy' ? { kind, coins: 1_000 } : { kind });
        void handleEngineStateSet(t.governor.serialize());
        return decision.allowed;
      },
    };
    t.lease = new EngineLease({
      ownerId,
      acquire: (id) => handleEngineLockAcquire({ ownerId: id }),
      release: (id) => void handleEngineLockRelease({ ownerId: id }),
      onGain: async () => {
        const state = await handleEngineStateGet();
        if (state) t.governor = Governor.hydrate(settings, state);
        return true;
      },
    });
    await t.lease.refresh();
    return t;
  }

  it('never allows more than one hourly budget across both tabs', async () => {
    const a = await openTab(A);
    const b = await openTab(B);
    expect(a.lease.isHeld()).toBe(true);
    expect(b.lease.isHeld()).toBe(false);

    const allowed = () => [a.act('search'), a.act('buy'), b.act('search'), b.act('buy'), a.act('search'), a.act('buy')];
    expect(allowed().filter(Boolean)).toHaveLength(4); // tab B was refused outright

    // Tab A closes (pagehide releases); tab B takes over on its next renewal
    // and picks up A's windows instead of its own stale copy.
    await handleEngineStateSet(a.governor.serialize());
    a.lease.release();
    await vi.waitFor(async () => expect(await b.lease.refresh()).toBe(true));
    expect(b.act('search')).toBe(false);
    expect(b.governor.snapshot().actionsLastHour).toBe(4);

    // An hour later the window has drained, for B too.
    // (B renewed its lease all along, as content/index.ts does every 20 s.)
    vi.setSystemTime(START + 3_600_001);
    expect(await b.lease.refresh()).toBe(true);
    expect(b.act('search')).toBe(true);
  });
});

describe('engineStateOf (what the heartbeat reports)', () => {
  it('reads halted, running, paused or idle from the engine', async () => {
    const { engineStateOf } = await import('../../src/content/engine-lease.js');
    const base = { killSwitch: false, probeOk: true, automationRunning: false, assistPaused: false };
    expect(engineStateOf(base)).toBe('idle');
    expect(engineStateOf({ ...base, assistPaused: true })).toBe('paused');
    expect(engineStateOf({ ...base, automationRunning: true })).toBe('running');
    expect(engineStateOf({ ...base, automationRunning: true, killSwitch: true })).toBe('halted');
    expect(engineStateOf({ ...base, probeOk: false })).toBe('halted');
  });
});
