// The sold cards cleared off the transfer list on their own every ten
// minutes (`lib/auto-clear-sold.ts`): a look at the list as EA's page last
// showed it, EA's own Clear Sold when sold cards sit on it, nothing when
// none do or the list has not been seen, never two at once, and what it
// last did for the page. The Clear sold button is untouched by it.

import { describe, expect, it, vi } from 'vitest';

import { AUTO_CLEAR_SOLD_EVERY_MS, createAutoClearSold } from '../../src/lib/auto-clear-sold.js';

const MIN = 60_000;

function setup(sold: () => number | null) {
  const clock = { t: 1_000_000 };
  let finish: (r: { ok: boolean; message: string }) => void = () => undefined;
  const clear = vi.fn((_count: number) => new Promise<{ ok: boolean; message: string }>((resolve) => (finish = resolve)));
  const auto = createAutoClearSold({ sold, clear, now: () => clock.t });
  return { auto, clock, clear, finish: (r: { ok: boolean; message: string }) => finish(r) };
}

describe('the automatic Clear Sold', () => {
  it('clears the sold cards every ten minutes when the list shows any, and not before', async () => {
    let sold: number | null = 3;
    const t = setup(() => sold);
    expect(AUTO_CLEAR_SOLD_EVERY_MS).toBe(10 * MIN);
    // The first look is a full interval after the page loaded.
    t.auto.tick();
    t.clock.t += 9 * MIN;
    t.auto.tick();
    expect(t.clear).not.toHaveBeenCalled();
    expect(t.auto.status()).toEqual({ everyMs: 10 * MIN, lastAt: null, lastResult: null, nextAt: 1_000_000 + 10 * MIN, busy: false });
    t.clock.t += MIN;
    t.auto.tick();
    expect(t.clear).toHaveBeenCalledWith(3);
    expect(t.auto.status().busy).toBe(true);
    // Not again while one runs, nor right after.
    t.auto.tick();
    t.finish({ ok: true, message: 'Cleared 3 sold cards' });
    await Promise.resolve();
    await Promise.resolve();
    t.auto.tick();
    expect(t.clear).toHaveBeenCalledTimes(1);
    expect(t.auto.status()).toEqual({ everyMs: 10 * MIN, lastAt: 1_000_000 + 10 * MIN, lastResult: { ok: true, message: 'Cleared 3 sold cards' }, nextAt: 1_000_000 + 20 * MIN, busy: false });
    // Ten minutes on: the list shows none sold (the clear's reload), so EA is not asked.
    sold = 0;
    t.clock.t += 10 * MIN;
    t.auto.tick();
    expect(t.clear).toHaveBeenCalledTimes(1);
    // Nor when the list has not been seen yet.
    sold = null;
    t.clock.t += 10 * MIN;
    t.auto.tick();
    expect(t.clear).toHaveBeenCalledTimes(1);
    sold = 1;
    t.clock.t += 10 * MIN;
    t.auto.tick();
    expect(t.clear).toHaveBeenCalledTimes(2);
    expect(t.clear).toHaveBeenLastCalledWith(1);
  });

  it('keeps a failed clear for the page, and tries again at the next interval', async () => {
    const t = setup(() => 2);
    t.clock.t += 10 * MIN;
    t.auto.tick();
    t.finish({ ok: false, message: 'Sold cards not cleared: EA did not answer in time' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.auto.status().lastResult).toEqual({ ok: false, message: 'Sold cards not cleared: EA did not answer in time' });
    t.clock.t += 10 * MIN;
    t.auto.tick();
    expect(t.clear).toHaveBeenCalledTimes(2);
  });

  it('says so when the clear itself throws', async () => {
    const clock = { t: 0 };
    const auto = createAutoClearSold({ sold: () => 1, clear: async () => Promise.reject(new Error('boom')), now: () => clock.t });
    clock.t = 10 * MIN;
    auto.tick();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(auto.status()).toMatchObject({ lastAt: 10 * MIN, lastResult: { ok: false, message: 'Sold cards not cleared: Error: boom' }, busy: false });
  });
});
