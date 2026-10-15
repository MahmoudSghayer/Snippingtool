// When Nova AI has the web app reload the transfer list
// (`lib/pile-refresh.ts`): soon after each listing, every few minutes while
// the bot runs or the page is open, never more than once in 30 s.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PILE_AFTER_LISTING_MS, PILE_EVERY_MS, PILE_MIN_GAP_MS, createPileRefresher } from '../../src/lib/pile-refresh.js';

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

function setup(refresh: () => Promise<unknown> = vi.fn(async () => undefined)) {
  const r = createPileRefresher({ refresh });
  return { r, refresh };
}

describe('after a listing', () => {
  it('reloads shortly after, once EA has the card on the market', () => {
    const { r, refresh } = setup();
    r.listed();
    vi.advanceTimersByTime(PILE_AFTER_LISTING_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('lets listings close together share one reload', () => {
    const { r, refresh } = setup();
    r.listed();
    vi.advanceTimersByTime(500);
    r.listed();
    r.listed();
    vi.advanceTimersByTime(PILE_AFTER_LISTING_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('waits out the 30 s gap after the last reload, and still reloads for the listing', async () => {
    const { r, refresh } = setup();
    r.tick(true); // a reload now
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    r.listed();
    await vi.advanceTimersByTimeAsync(PILE_MIN_GAP_MS - 5_000 - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('while the bot runs or the page is open', () => {
  it('reloads at once, then every few minutes', async () => {
    const { r, refresh } = setup();
    r.tick(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PILE_EVERY_MS - 1);
    r.tick(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    r.tick(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does nothing when neither', () => {
    const { r, refresh } = setup();
    r.tick(false);
    vi.advanceTimersByTime(PILE_EVERY_MS * 3);
    r.tick(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('leaves it to a reload already coming for a listing', () => {
    const { r, refresh } = setup();
    r.listed();
    r.tick(true);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PILE_AFTER_LISTING_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it('never starts a reload while one is still on its way', async () => {
  let finish!: () => void;
  const refresh = vi.fn(() => new Promise<void>((res) => (finish = res)));
  const { r } = setup(refresh);
  r.tick(true);
  vi.advanceTimersByTime(PILE_EVERY_MS);
  r.tick(true);
  expect(refresh).toHaveBeenCalledTimes(1);
  finish();
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(PILE_EVERY_MS);
  r.tick(true);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('carries on after a reload that failed', async () => {
  const refresh = vi.fn(async () => {
    throw new Error('EA said no');
  });
  const { r } = setup(refresh);
  r.tick(true);
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(PILE_EVERY_MS);
  r.tick(true);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('cancels a reload still waiting when disposed', () => {
  const { r, refresh } = setup();
  r.listed();
  r.dispose();
  vi.advanceTimersByTime(PILE_MIN_GAP_MS);
  expect(refresh).not.toHaveBeenCalled();
});
