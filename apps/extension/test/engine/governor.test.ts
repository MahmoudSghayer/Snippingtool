import { DEFAULT_GOVERNOR_SETTINGS, GOVERNOR_ABSOLUTE_LIMITS, type GovernorSettings } from '@sl/shared';
import { describe, expect, it } from 'vitest';

import { Governor, OBSERVED_SEARCH_DEDUPE_MS } from '../../src/engine/governor.js';

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
    // Settings are clamped to GOVERNOR_ABSOLUTE_LIMITS (ratio ceiling 1), so
    // enough searches are made that the ratio never interferes here.
    const { gov } = governorAt(START, { maxCoinFlowPerHour: 1000, buyToSearchRatio: 1, actionsPerHour: 120 });
    gov.allow({ kind: 'search' });
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
      buyToSearchRatio: 1,
      actionsPerHour: 120,
      sessionLengthMinutes: 240,
    });
    gov.allow({ kind: 'search' }, START);
    expect(gov.allow({ kind: 'buy', coins: 900 }, START).allowed).toBe(true);
    setNow(START + 3_600_001);
    gov.allow({ kind: 'search' });
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

describe('Governor — searches are counted (defect C1)', () => {
  it('allows buys under default settings while searches keep the ratio in bounds', () => {
    // DEFAULT_GOVERNOR_SETTINGS: ratio 0.35, 30 actions/hour. Three searches
    // per buy keeps buys/searches at 1/3, 2/6, 3/9 … — always <= 0.35.
    let clock = START;
    const gov = new Governor(DEFAULT_GOVERNOR_SETTINGS, { now: () => clock });
    for (let round = 0; round < 5; round++) {
      for (let s = 0; s < 3; s++) {
        clock += 20_000;
        expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
      }
      clock += 20_000;
      const buy = gov.allow({ kind: 'buy', coins: 10_000 });
      expect(buy.allowed, `buy #${round + 1}: ${buy.reason ?? ''}`).toBe(true);
    }
    expect(gov.snapshot().buyToSearchRatio).toBeCloseTo(5 / 15);
    // A buy with no search since the last one pushes the ratio to 6/15 = 0.4.
    expect(gov.allow({ kind: 'buy', coins: 10_000 }).reason).toBe('buy_search_ratio');
  });

  it('recordObservedSearch counts a user-issued search toward the ratio and actionsPerHour without gating', () => {
    const { gov, setNow } = governorAt(START, { buyToSearchRatio: 0.5, actionsPerHour: 120 });
    expect(gov.recordObservedSearch()).toBe(true);
    setNow(START + 10_000);
    expect(gov.recordObservedSearch()).toBe(true);
    expect(gov.snapshot().actionsLastHour).toBe(2);
    // 1 buy / 2 observed searches = 0.5 — allowed only because they counted.
    expect(gov.allow({ kind: 'buy', coins: 100 }).allowed).toBe(true);
  });

  it('recordObservedSearch never gates, even with the kill switch active (it records what already happened)', () => {
    const { gov } = governorAt(START);
    gov.setKillSwitch(true);
    expect(gov.recordObservedSearch()).toBe(true);
    expect(gov.snapshot().actionsLastHour).toBe(1);
  });

  it('counts one search once even though the adapter reports it twice', () => {
    const { gov, setNow } = governorAt(START, { actionsPerHour: 120 });
    expect(gov.recordObservedSearch()).toBe(true);
    setNow(START + 50);
    expect(gov.recordObservedSearch()).toBe(false); // the duplicate report
    setNow(START + OBSERVED_SEARCH_DEDUPE_MS + 100);
    expect(gov.recordObservedSearch()).toBe(true); // a genuinely new search
    expect(gov.snapshot().actionsLastHour).toBe(2);
  });

  it('does not re-count the response of an engine-issued (gated) search', () => {
    const { gov, setNow } = governorAt(START, { actionsPerHour: 120 });
    gov.beginEngineSearch();
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
    // A slow response, well past the dedupe window, still belongs to it.
    setNow(START + OBSERVED_SEARCH_DEDUPE_MS * 5);
    expect(gov.recordObservedSearch()).toBe(false);
    expect(gov.recordObservedSearch()).toBe(false);
    gov.endEngineSearch();
    // A trailing duplicate right after the call settles is still absorbed.
    setNow(START + OBSERVED_SEARCH_DEDUPE_MS * 5 + 50);
    expect(gov.recordObservedSearch()).toBe(false);
    expect(gov.snapshot().actionsLastHour).toBe(1);
  });
});

describe('Governor — settings are clamped to GOVERNOR_ABSOLUTE_LIMITS', () => {
  const wild: GovernorSettings = {
    actionsPerHour: 100_000,
    sessionLengthMinutes: 1,
    buyToSearchRatio: 50,
    cooldownSeconds: -5,
    maxCoinFlowPerHour: 999_999_999,
  };
  const expected: GovernorSettings = {
    actionsPerHour: GOVERNOR_ABSOLUTE_LIMITS.actionsPerHour.max,
    sessionLengthMinutes: GOVERNOR_ABSOLUTE_LIMITS.sessionLengthMinutes.min,
    buyToSearchRatio: GOVERNOR_ABSOLUTE_LIMITS.buyToSearchRatio.max,
    cooldownSeconds: GOVERNOR_ABSOLUTE_LIMITS.cooldownSeconds.min,
    maxCoinFlowPerHour: GOVERNOR_ABSOLUTE_LIMITS.maxCoinFlowPerHour.max,
  };

  it('clamps in the constructor', () => {
    const gov = new Governor(wild, { now: () => START });
    expect(gov.getSettings()).toEqual(expected);
    expect(gov.snapshot().actionsPerHourLimit).toBe(120);
  });

  it('clamps in setSettings', () => {
    const gov = new Governor(DEFAULT_GOVERNOR_SETTINGS, { now: () => START });
    gov.setSettings(wild);
    expect(gov.getSettings()).toEqual(expected);
  });

  it('clamps on hydrate, and enforces the clamped ceiling', () => {
    const gov = Governor.hydrate({ ...wild, sessionLengthMinutes: 240 }, new Governor(DEFAULT_GOVERNOR_SETTINGS, { now: () => START }).serialize(), {
      now: () => START,
    });
    for (let i = 0; i < 120; i++) expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
    expect(gov.allow({ kind: 'search' }).reason).toBe('hard_stop');
  });

  it('falls back to the shipped default for a non-finite value', () => {
    const gov = new Governor({ ...DEFAULT_GOVERNOR_SETTINGS, actionsPerHour: Number.NaN }, { now: () => START });
    expect(gov.getSettings().actionsPerHour).toBe(DEFAULT_GOVERNOR_SETTINGS.actionsPerHour);
  });
});

describe('Governor — session reset', () => {
  it('starts a new session once the session-length stop\'s cooldown has elapsed', () => {
    const { gov, setNow } = governorAt(START, { sessionLengthMinutes: 10, actionsPerHour: 120, cooldownSeconds: 30, buyToSearchRatio: 0.5 });
    gov.allow({ kind: 'search' }, START);
    gov.allow({ kind: 'search' }, START);
    const sessionEnd = START + 11 * 60_000;
    setNow(sessionEnd);
    const tripped = gov.allow({ kind: 'search' });
    expect(tripped.reason).toBe('hard_stop');
    expect(tripped.events.some((e) => e.kind === 'session_length')).toBe(true);

    setNow(sessionEnd + 29_000);
    expect(gov.allow({ kind: 'search' }).allowed).toBe(false); // still cooling down

    setNow(sessionEnd + 30_001);
    // Previously this re-tripped session_length forever.
    expect(gov.allow({ kind: 'search' }).allowed).toBe(true);
    const snap = gov.snapshot();
    expect(snap.sessionElapsedMinutes).toBeLessThan(1);
    expect(snap.inCooldown).toBe(false);
    // Per-session ratio counters started over: 1 search so far this session.
    expect(gov.serialize()).toMatchObject({ searchCount: 1, buyCount: 0, sessionExpired: false });
    // …but the hourly window did not: the 2 searches from before still count.
    expect(snap.actionsLastHour).toBe(3);
  });

  it('carries a tripped session across serialize/hydrate so the reset still happens after a reload', () => {
    const { gov } = governorAt(START, { sessionLengthMinutes: 10, cooldownSeconds: 30 });
    const sessionEnd = START + 11 * 60_000;
    expect(gov.allow({ kind: 'search' }, sessionEnd).reason).toBe('hard_stop');
    const reloaded = Governor.hydrate({ ...settings, sessionLengthMinutes: 10, cooldownSeconds: 30 }, gov.serialize(), {
      now: () => sessionEnd + 31_000,
    });
    expect(reloaded.allow({ kind: 'search' }).allowed).toBe(true);
  });

  it('resetSession() starts a new session but never clears a cooldown or the hourly windows', () => {
    const { gov, setNow } = governorAt(START, { actionsPerHour: 1, cooldownSeconds: 30, sessionLengthMinutes: 60 });
    gov.allow({ kind: 'search' }, START);
    expect(gov.allow({ kind: 'search' }, START + 10).reason).toBe('hard_stop');
    setNow(START + 20 * 60_000);
    gov.resetSession();
    const snap = gov.snapshot();
    expect(snap.sessionElapsedMinutes).toBe(0);
    expect(snap.actionsLastHour).toBe(1);
    expect(gov.serialize()).toMatchObject({ searchCount: 0, buyCount: 0 });
    // still over the hourly window — a session reset is not a bypass
    expect(gov.allow({ kind: 'search' }).allowed).toBe(false);
  });
});
