// What the session timer, the session budget meter and the daily profit
// goal show (P0 Task 13, items 3 and 6), as data a UI renders: the popup
// that was to show them is being stripped down, so they are built here for
// the Sniping Bot page to place.
import { describe, expect, it } from 'vitest';

import { dailyGoalProgress, sessionMeters } from '../../src/lib/session-meters.js';

describe('sessionMeters', () => {
  it('times the session against its length and the spend against the budget', () => {
    const m = sessionMeters({ sessionElapsedMinutes: 12.5, sessionLengthLimitMinutes: 90, sessionCoinsSpent: 25_000 }, 100_000);
    expect(m.timer).toEqual({ elapsedMs: 750_000, limitMs: 5_400_000, fraction: 750_000 / 5_400_000, label: '12:30 / 90:00' });
    expect(m.spend).toEqual({ spent: 25_000, cap: 100_000, fraction: 0.25, label: '25,000 / 100,000' });
  });

  it('has no spend fraction without a session budget, and caps nothing it shows', () => {
    const m = sessionMeters({ sessionElapsedMinutes: 100, sessionLengthLimitMinutes: 90, sessionCoinsSpent: 5_000 }, null);
    expect(m.spend).toEqual({ spent: 5_000, cap: null, fraction: null, label: '5,000 (no cap)' });
    expect(m.timer.fraction).toBeGreaterThan(1);
    expect(m.timer.label).toBe('100:00 / 90:00');
  });
});

describe('dailyGoalProgress', () => {
  it('measures today’s realised profit against the goal', () => {
    expect(dailyGoalProgress(12_000, 50_000)).toEqual({ realised: 12_000, goal: 50_000, fraction: 0.24, reached: false });
    expect(dailyGoalProgress(60_000, 50_000).reached).toBe(true);
  });

  it('has nothing to measure without a goal, and a loss is no progress', () => {
    expect(dailyGoalProgress(12_000, null)).toEqual({ realised: 12_000, goal: null, fraction: null, reached: false });
    expect(dailyGoalProgress(-3_000, 50_000).fraction).toBe(0);
  });
});
