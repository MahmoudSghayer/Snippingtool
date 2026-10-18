// The adapter watchdog (P0 Task 13, item 7): it used to log its "possible
// MAIN-world stall" warning on every 15 s check for as long as the adapter
// stayed quiet. Now it warns once per stall, and again only after the
// adapter has been heard from in between. Production then reported
// thousands of false stalls a day: idle pages (the adapter only probed on
// act calls) and background tabs, whose timers Chrome throttles to about
// once a minute. So it now takes several quiet checks in a row, ignores a
// check that itself ran late, allows a hidden tab much longer, and warns at
// most once every ten minutes.
import { describe, expect, it, vi } from 'vitest';

import { createWatchdog } from '../../src/content/watchdog.js';

const CHECK = 15_000;
const STALE = 60_000;

function dog(opts: { hidden?: () => boolean } = {}) {
  const clock = { now: 0 };
  const warn = vi.fn();
  const recovered = vi.fn();
  const watchdog = createWatchdog({
    staleMs: STALE,
    hiddenStaleMs: 5 * 60_000,
    checkMs: CHECK,
    isHidden: opts.hidden,
    now: () => clock.now,
    warn,
    recovered,
  });
  /** Runs a check every `step` ms until `until`. */
  const checkUntil = (until: number, step = CHECK) => {
    for (; clock.now < until; ) {
      clock.now += step;
      watchdog.check();
    }
  };
  return { clock, warn, recovered, watchdog, checkUntil };
}

describe('content/watchdog.ts', () => {
  it('warns once per stall, not on every check', () => {
    let now = 0;
    const warn = vi.fn();
    const recovered = vi.fn();
    const dog = createWatchdog({ staleMs: 60_000, checkMs: 15_000, now: () => now, warn, recovered });
    for (now = 0; now <= 60_000; now += 15_000) dog.check();
    expect(warn).not.toHaveBeenCalled();
    for (; now <= 10 * 60_000; now += 15_000) dog.check();
    expect(warn).toHaveBeenCalledTimes(1);

    dog.seen();
    expect(recovered).toHaveBeenCalledTimes(1);
    dog.seen();
    expect(recovered).toHaveBeenCalledTimes(1);
    const back = now;
    for (; now <= back + 5 * 60_000; now += 15_000) dog.check();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('takes three quiet checks in a row: hearing from the adapter in between starts over', () => {
    const d = dog();
    d.checkUntil(STALE + 2 * CHECK); // quiet 75 s, 90 s: two misses
    expect(d.warn).not.toHaveBeenCalled();
    d.watchdog.seen(); // a heartbeat
    d.checkUntil(d.clock.now + STALE + 2 * CHECK);
    expect(d.warn).not.toHaveBeenCalled();
    d.checkUntil(d.clock.now + CHECK); // the third in a row
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.warn.mock.calls[0]![0]).toBeGreaterThan(STALE);
  });

  it('a heartbeat every 20 s keeps it quiet for good, even with no probe result at all', () => {
    const d = dog();
    for (let t = 0; t < 60 * 60_000; t += 5_000) {
      d.clock.now = t;
      if (t % 20_000 === 0) d.watchdog.seen();
      if (t % CHECK === 0) d.watchdog.check();
    }
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('a check that ran late (a throttled timer, a frozen page, a sleeping laptop) counts for nothing', () => {
    const d = dog();
    // The page froze for ten minutes: both timers stood still.
    d.clock.now += 10 * 60_000;
    d.watchdog.check();
    d.clock.now += 2 * 60_000;
    d.watchdog.check();
    expect(d.warn).not.toHaveBeenCalled();
    // Once it runs on time again, the adapter gets its checks to report.
    d.watchdog.seen();
    d.checkUntil(d.clock.now + 5 * 60_000);
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  it('allows a hidden tab five minutes, where Chrome fires timers about once a minute', () => {
    const d = dog({ hidden: () => true });
    // Checks once a minute (intensive throttling), adapter quiet throughout:
    // well past a visible tab's minute, under the hidden tab's allowance.
    d.checkUntil(5 * 60_000, 60_000);
    expect(d.warn).not.toHaveBeenCalled();
    d.checkUntil(8 * 60_000 + 30_000, 60_000);
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  it('the first check after the tab is hidden or shown starts the count over', () => {
    let hidden = false;
    const d = dog({ hidden: () => hidden });
    d.checkUntil(STALE + 2 * CHECK); // two misses
    hidden = true;
    d.checkUntil(d.clock.now + CHECK); // would have been the third
    expect(d.warn).not.toHaveBeenCalled();
    hidden = false;
    d.checkUntil(d.clock.now + 3 * CHECK); // shown again: this check, then two misses
    expect(d.warn).not.toHaveBeenCalled();
    d.checkUntil(d.clock.now + CHECK);
    expect(d.warn).toHaveBeenCalledTimes(1);
  });

  it('warns at most once every ten minutes, however often the adapter goes quiet and comes back', () => {
    const d = dog();
    for (let stall = 0; stall < 8; stall++) {
      d.checkUntil(d.clock.now + STALE + 3 * CHECK); // each long enough to warn
      d.watchdog.seen();
    }
    // Eight stalls in 14 minutes: two warnings, not eight.
    expect(d.clock.now).toBe(14 * 60_000);
    expect(d.warn).toHaveBeenCalledTimes(2);
    expect(d.recovered).toHaveBeenCalledTimes(2);
    // A stall still going when the ten minutes are up is reported then.
    d.checkUntil(d.clock.now + 10 * 60_000);
    expect(d.warn).toHaveBeenCalledTimes(3);
  });
});
