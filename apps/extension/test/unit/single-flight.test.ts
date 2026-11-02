// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Unit coverage for lib/single-flight.ts, pulled out of
// content/index.ts's `engineTick()` re-entrancy bug: `setInterval(() =>
// void engineTick(), AUTOBUYER_TICK_MS)` had no guard against a second tick
// firing while the first was still awaiting `refreshSummaries()` /
// `autobuyer.runCycle`. `content/index.ts` itself isn't unit-testable in
// isolation (it wires up the whole content-script bootstrap), so the guard
// is tested here on its own.

import { describe, expect, it, vi } from 'vitest';

import { singleFlight } from '../../src/lib/single-flight.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('lib/single-flight.ts', () => {
  it('a call made while the first is still pending is dropped without invoking the wrapped function again', async () => {
    const gate = deferred<void>();
    const inner = vi.fn(async () => {
      await gate.promise;
    });
    const guarded = singleFlight(inner);

    const first = guarded();
    const second = guarded(); // fires while `first` is still awaiting the gate

    expect(inner).toHaveBeenCalledTimes(1); // the overlapping call never ran `fn` a second time

    gate.resolve();
    await first;
    await second;

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('a call made after the previous one has resolved runs normally', async () => {
    const inner = vi.fn(async () => undefined);
    const guarded = singleFlight(inner);

    await guarded();
    await guarded();
    await guarded();

    expect(inner).toHaveBeenCalledTimes(3);
  });

  it('the guard is released even if the wrapped function rejects, so the next call still runs (finally, not just on success)', async () => {
    const inner = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    const guarded = singleFlight(inner as unknown as () => Promise<void>);

    await expect(guarded()).rejects.toThrow('boom');
    await guarded();

    expect(inner).toHaveBeenCalledTimes(2); // second call was not permanently blocked by the first's failure
  });

  it('forwards arguments through to the wrapped function', async () => {
    const inner = vi.fn(async (a: number, b: string) => {
      void a;
      void b;
    });
    const guarded = singleFlight(inner);

    await guarded(42, 'x');

    expect(inner).toHaveBeenCalledWith(42, 'x');
  });
});

describe('sharedFlight', () => {
  it('a call made while the first is pending joins it: one run, the same answer for both', async () => {
    const { sharedFlight } = await import('../../src/lib/single-flight.js');
    const gate = deferred<number>();
    const inner = vi.fn(() => gate.promise);
    const shared = sharedFlight(inner);
    const first = shared();
    const second = shared();
    expect(second).toBe(first);
    expect(inner).toHaveBeenCalledTimes(1);
    gate.resolve(7);
    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toBe(7);
    // Released: the next call runs again.
    const third = shared();
    expect(third).not.toBe(first);
    expect(inner).toHaveBeenCalledTimes(2);
    gate.resolve(7);
    await third;
  });

  it('a rejection is shared too, and does not wedge the guard', async () => {
    const { sharedFlight } = await import('../../src/lib/single-flight.js');
    let calls = 0;
    const shared = sharedFlight(async () => {
      calls++;
      if (calls === 1) throw new Error('first');
      return 'ok';
    });
    const a = shared();
    const b = shared();
    await expect(a).rejects.toThrow('first');
    await expect(b).rejects.toThrow('first');
    await expect(shared()).resolves.toBe('ok');
    expect(calls).toBe(2);
  });
});
