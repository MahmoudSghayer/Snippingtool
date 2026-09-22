import { DEFAULT_GOVERNOR_SETTINGS, type GovernorSettings } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { Governor } from '../../src/engine/governor.js';

const settings: GovernorSettings = {
  ...DEFAULT_GOVERNOR_SETTINGS,
  actionsPerHour: 5,
  sessionLengthMinutes: 60,
  buyToSearchRatio: 0.5,
  cooldownSeconds: 30,
  maxCoinFlowPerHour: 10_000,
};

const START = 1_700_000_000_000;

function governorAt(t: number, overrides: Partial<GovernorSettings> = {}) {
  let clock = t;
  const gov = new Governor({ ...settings, ...overrides }, { now: () => clock });
  return {
    gov,
    setNow: (n: number) => {
      clock = n;
    },
  };
}

describe('Governor — kill switch', () => {
  it('denies everything unconditionally once active, regardless of budget state', () => {
    const { gov } = governorAt(START);
    gov.setKillSwitch(true, 'server said stop');
    const decision = gov.allow({ kind: 'search' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('kill_switch');
    expect(decision.events[0]).toMatchObject({ kind: 'kill_switch' });
  });

  it('resumes normal operation once cleared', () => {
    const { gov } = governorAt(START);
    gov.setKillSwitch(true);
    gov.setKillSwitch(false);
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
  });
});

describe('Governor — actionsPerHour', () => {
  it('allows up to the limit and denies the one after', () => {
    const { gov } = governorAt(START, { actionsPerHour: 3 });
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
    const fourth = gov.allow({ kind: 'search' });
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe('hard_stop');
    expect(fourth.events.some((e) => e.kind === 'actions_per_hour')).toBe(true);
  });

  it('is a sliding window: actions older than an hour drop out', () => {
    // sessionLengthMinutes is overridden well above the 1h+1ms jump below
    // so that threshold can't also fire and confound this test.
    const { gov, setNow } = governorAt(START, { actionsPerHour: 2, sessionLengthMinutes: 999 });
    expect(gov.allow({ kind: 'search' }, START).allowed).toBe(true);
    expect(gov.allow({ kind: 'search' }, START + 1000).allowed).toBe(true);
    setNow(START + 3_600_001);
    // both prior actions are now outside the 1h window
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
  });

  it('hard-stop triggers a cooldown that blocks further actions', () => {
    const { gov, setNow } = governorAt(START, { actionsPerHour: 1, cooldownSeconds: 30, sessionLengthMinutes: 999 });
    expect(gov.allow({ kind: 'search' }, START).allowed).toBe(true);
    const denied = gov.allow({ kind: 'search' }, START + 10);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('hard_stop');
    // still in cooldown a moment later
    setNow(START + 15_000);
    expect(gov.allow({ kind: 'search' }).allowed).toBe(false);
    // cooldown has elapsed, but the very first action is still inside the
    // 1h actionsPerHour window (only 30s have passed) — actionsPerHour: 1
    // means a second action this soon hard-stops again, which is correct:
    // the cooldown clearing and the hourly window clearing are two
    // different clocks, and both have to clear before allow() succeeds.
    setNow(START + 30_001);
    const stillOverHourly = gov.allow({ kind: 'search' });
    expect(stillOverHourly.allowed).toBe(false);
    expect(stillOverHourly.reason).toBe('hard_stop');
    // once the 1h window has fully cleared too, the same governor recovers.
    setNow(START + 3_600_001);
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
  });
});

describe('Governor — sessionLengthMinutes', () => {
  it('hard-stops once the session has run longer than the limit', () => {
    const { gov, setNow } = governorAt(START, { sessionLengthMinutes: 10, actionsPerHour: 999 });
    setNow(START + 11 * 60_000);
    const decision = gov.allow({ kind: 'search' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('hard_stop');
    expect(decision.events.some((e) => e.kind === 'session_length')).toBe(true);
  });
});

describe('Governor — buyToSearchRatio', () => {
  it('allows a buy within the ratio and denies one that would exceed it', () => {
    const { gov } = governorAt(START, { buyToSearchRatio: 0.5, actionsPerHour: 999 });
    gov.allow({ kind: 'search' });
    gov.allow({ kind: 'search' });
    // 1 buy / 2 searches = 0.5, exactly at the limit — allowed.
    expect(gov.allow({ kind: 'buy', coins: 100 }).allowed).toBe(true);
    // a second buy would make it 2/2 = 1.0 > 0.5 — denied.
    const denied = gov.allow({ kind: 'buy', coins: 100 });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('buy_search_ratio');
  });

  it('does not hard-stop on a ratio breach — only that one action is denied', () => {
    const { gov } = governorAt(START, { buyToSearchRatio: 0.1, actionsPerHour: 999 });
    const denied = gov.allow({ kind: 'buy', coins: 100 }); // 0 searches -> ratio = 1/1 = 1 > 0.1
    expect(denied.allowed).toBe(false);
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
  });

  it('treats zero searches as a denominator of 1, not a divide-by-zero', () => {
    const { gov } = governorAt(START, { buyToSearchRatio: 1, actionsPerHour: 999 });
    // 1 buy / max(0,1) = 1, exactly at the limit — allowed.
    expect(gov.allow({ kind: 'buy', coins: 10 }).allowed).toBe(true);
  });
});

describe('Governor — maxCoinFlowPerHour', () => {
  it('allows spend within budget and denies a buy that would exceed it', () => {
    const { gov } = governorAt(START, { maxCoinFlowPerHour: 1000, buyToSearchRatio: 999, actionsPerHour: 999 });
    gov.allow({ kind: 'search' });
    expect(gov.allow({ kind: 'buy', coins: 900 }).allowed).toBe(true);
    const denied = gov.allow({ kind: 'buy', coins: 200 }); // 900 + 200 > 1000
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('coin_flow');
    expect(denied.events[0]).toMatchObject({ kind: 'coin_flow', threshold: 1000 });
  });

  it('coin flow is a sliding window', () => {
    const { gov, setNow } = governorAt(START, {
      maxCoinFlowPerHour: 1000,
      buyToSearchRatio: 999,
      actionsPerHour: 999,
      sessionLengthMinutes: 999,
    });
    expect(gov.allow({ kind: 'buy', coins: 900 }, START).allowed).toBe(true);
    setNow(START + 3_600_001);
    // the earlier 900-coin spend has aged out of the window
    expect(gov.allow({ kind: 'buy', coins: 900 }).allowed).toBe(true);
  });
});

describe('Governor — snapshot', () => {
  it('reports utilization without denying anything', () => {
    const { gov } = governorAt(START, { actionsPerHour: 10, maxCoinFlowPerHour: 5000, buyToSearchRatio: 999 });
    gov.allow({ kind: 'search' });
    gov.allow({ kind: 'buy', coins: 1000 });
    const snap = gov.snapshot();
    expect(snap.actionsLastHour).toBe(2);
    expect(snap.coinFlowLastHour).toBe(1000);
    expect(snap.buyToSearchRatio).toBe(1);
    expect(snap.killSwitchActive).toBe(false);
    expect(snap.inCooldown).toBe(false);
  });
});

describe('Governor — serialize/hydrate', () => {
  it('round-trips state across a simulated reload', () => {
    const { gov } = governorAt(START, { actionsPerHour: 10, buyToSearchRatio: 999 });
    gov.allow({ kind: 'search' });
    gov.allow({ kind: 'buy', coins: 500 });
    const state = gov.serialize();

    const rehydrated = Governor.hydrate({ ...settings, buyToSearchRatio: 999 }, state, { now: () => START + 1 });
    const snap = rehydrated.snapshot();
    expect(snap.actionsLastHour).toBe(2);
    expect(snap.coinFlowLastHour).toBe(500);
  });
});
