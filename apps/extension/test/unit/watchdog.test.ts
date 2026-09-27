// The adapter watchdog (P0 Task 13, item 7): it used to log its "possible
// MAIN-world stall" warning on every 15 s check for as long as the adapter
// stayed quiet. Now it warns once per stall, and again only after the
// adapter has been heard from in between.
import { describe, expect, it, vi } from 'vitest';

import { createWatchdog } from '../../src/content/watchdog.js';

describe('content/watchdog.ts', () => {
  it('warns once per stall, not on every check', () => {
    let now = 0;
    const warn = vi.fn();
    const recovered = vi.fn();
    const dog = createWatchdog({ staleMs: 60_000, now: () => now, warn, recovered });
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
});
