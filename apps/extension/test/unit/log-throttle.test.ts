// lib/log-throttle.ts: one log line per key every so often, for warnings
// that can repeat on every EA answer (an EA error on every search while EA
// rate-limits the account, a trade-pile shape change on every reload).
import { describe, expect, it } from 'vitest';

import { createLogThrottle, droppedSuffix } from '../../src/lib/log-throttle.js';

describe('lib/log-throttle.ts', () => {
  it('lets one line per key through every gap, and counts the ones it dropped', () => {
    let now = 0;
    const gate = createLogThrottle(600_000, () => now);
    expect(gate('ea:market:rate_limited')).toBe(0);
    for (let i = 0; i < 40; i++) {
      now += 10_000;
      expect(gate('ea:market:rate_limited')).toBeNull();
    }
    // Another key has its own gap.
    expect(gate('ea:pile:session_ended')).toBe(0);
    now = 600_000;
    expect(gate('ea:market:rate_limited')).toBe(40);
    expect(gate('ea:market:rate_limited')).toBeNull();
  });

  it('says how many it dropped, or nothing', () => {
    expect(droppedSuffix(0)).toBe('');
    expect(droppedSuffix(3)).toBe(' (and 3 more like it since)');
  });

  it('remembers a bounded number of keys', () => {
    const gate = createLogThrottle(600_000, () => 0);
    for (let i = 0; i < 1_000; i++) gate(`key${i}`);
    // The oldest were forgotten, so they pass again; the newest still wait.
    expect(gate('key0')).toBe(0);
    expect(gate('key999')).toBeNull();
  });
});
