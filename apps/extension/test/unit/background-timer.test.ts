// lib/background-timer.ts: Nova AI's waits, timed in a worker so a hidden
// tab's timer throttling does not slow the bot, with the page's setTimeout
// as the fallback when the worker cannot run or stops answering.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackgroundTimer } from '../../src/lib/background-timer.js';

/** A stand-in for the worker: records what it was asked, and lets a test
 * deliver its "done" messages or its error. */
function fakeWorker() {
  const listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  const posted: unknown[] = [];
  return {
    posted,
    worker: {
      postMessage: (m: unknown) => void posted.push(m),
      addEventListener: (type: string, cb: (e: MessageEvent) => void) => {
        (listeners[type] ??= []).push(cb);
      },
    } as unknown as Worker,
    fire: (id: number) => listeners.message?.forEach((cb) => cb({ data: id } as MessageEvent)),
    fail: () => listeners.error?.forEach((cb) => cb({} as MessageEvent)),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createBackgroundTimer', () => {
  it('waits on the worker, not on the page timers', async () => {
    const w = fakeWorker();
    const timer = createBackgroundTimer(() => w.worker);
    expect(timer.mode()).toBe('worker');
    let done = false;
    void timer.sleep(10_000, new AbortController().signal).then(() => (done = true));
    expect(w.posted).toEqual([['set', 1, 10_000]]);

    await vi.advanceTimersByTimeAsync(9_999);
    w.fire(1);
    await Promise.resolve();
    expect(done).toBe(true);
    expect(timer.mode()).toBe('worker');
  });

  it('ends a wait at once when aborted, and tells the worker to drop it', async () => {
    const w = fakeWorker();
    const timer = createBackgroundTimer(() => w.worker);
    const abort = new AbortController();
    const wait = timer.sleep(10_000, abort.signal);
    abort.abort();
    await wait;
    expect(w.posted).toEqual([
      ['set', 1, 10_000],
      ['clear', 1],
    ]);
  });

  it('falls back to setTimeout when there is no worker', async () => {
    const timer = createBackgroundTimer(() => null);
    expect(timer.mode()).toBe('page');
    let done = false;
    void timer.sleep(5_000, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('re-times waits on setTimeout when the page blocks the worker', async () => {
    const w = fakeWorker();
    const timer = createBackgroundTimer(() => w.worker);
    let done = false;
    void timer.sleep(5_000, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2_000);
    w.fail();
    expect(timer.mode()).toBe('page');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    // Later waits go straight to setTimeout.
    void timer.sleep(1_000, new AbortController().signal);
    expect(w.posted).toHaveLength(1);
  });

  it('never gets stuck on a worker that stops answering', async () => {
    const w = fakeWorker();
    const timer = createBackgroundTimer(() => w.worker);
    let done = false;
    void timer.sleep(1_000, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(5_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // 1 s wait + 5 s grace
    expect(done).toBe(true);
    expect(timer.mode()).toBe('page');
  });
});
