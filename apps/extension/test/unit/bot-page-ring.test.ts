// The Nova AI page's countdown ring (`ui/bot-page.ts`): built once and
// updated every animation frame, so the arc moves continuously, and moved
// (not rebuilt) when the dash re-renders, so a refresh never restarts it.

import { DEFAULT_BOT_SETTINGS } from '@sl/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Sniper } from '../../src/engine/sniper.js';
import { createBotPage } from '../../src/ui/bot-page.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  trustTestEvents();
});
afterEach(() => {
  vi.useRealTimers();
  untrustedEvents();
});

function makeSniper(): Sniper {
  return new Sniper(
    {
      adapter: {
        search: vi.fn(),
        buy: vi.fn(),
        list: vi.fn(),
        onAuctions: () => () => undefined,
        onBuyable: () => () => undefined,
        onProbe: () => () => undefined,
        onShape: () => () => undefined,
      },
      getFilters: () => [],
      estimateSellPrice: async () => null,
      killSwitch: () => ({ active: false }),
      onChange: () => undefined,
    },
    DEFAULT_BOT_SETTINGS,
  );
}

function mountPage(sniper: Sniper) {
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => sniper,
    getUnavailableReason: () => null,
    prepare: async () => undefined,
    getSettings: () => DEFAULT_BOT_SETTINGS,
    saveSettings: async () => undefined,
    setLiveSearch: () => undefined,
    resolveNames: async () => ({}),
    getCatalog: async () => null,
  });
  page.open();
  shadows.restore();
  return { page, root: shadows.rootOf(document.getElementById('ledger-bot-page')!) };
}

it('hands each wait to the compositor as two rotations, and a refresh neither restarts them nor rebuilds the dash', () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  try {
    const sniper = makeSniper();
    let state = { ...sniper.state, phase: 'waiting' as const, phaseEndsAt: Date.now() + 10_000 };
    vi.spyOn(sniper, 'state', 'get').mockImplementation(() => state);
    const { page, root } = mountPage(sniper);

    // Only transform animates (compositor-friendly): the left half turns
    // away during the first half of the wait, the right half during the second.
    expect(animate).toHaveBeenCalledTimes(2);
    const calls = animate.mock.calls as unknown as [Keyframe[], KeyframeAnimationOptions][];
    for (const [frames] of calls) expect(frames).toEqual([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-180deg)' }]);
    expect(calls[0]![1]).toMatchObject({ duration: 5_000, easing: 'linear', fill: 'forwards' });
    expect(calls[1]![1]).toMatchObject({ duration: 5_000, delay: 5_000, easing: 'linear', fill: 'both' });

    const searches = root.getElementById('d-searches');
    vi.advanceTimersByTime(3_000);
    page.refresh();
    vi.advanceTimersByTime(20);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(root.getElementById('d-searches')).toBe(searches);

    // The next wait gets its own animations.
    state = { ...state, phaseEndsAt: Date.now() + 8_000 };
    vi.advanceTimersByTime(20);
    expect(animate).toHaveBeenCalledTimes(4);
    page.close();
  } finally {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  }
});

it('runs no animation frame while idle: nothing moves, so scrolling and settings stay smooth', () => {
  const sniper = makeSniper();
  // Idle: not running, no phase counting down (the default state).
  const { page } = mountPage(sniper);
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
  vi.advanceTimersByTime(1_000);
  // The ring loop never schedules a frame while nothing is moving.
  expect(raf).not.toHaveBeenCalled();
  page.close();
  raf.mockRestore();
});

it('counts a wait down every frame, and a dash refresh does not restart it', () => {
  const sniper = new Sniper(
    {
      adapter: {
        search: vi.fn(),
        buy: vi.fn(),
        list: vi.fn(),
        onAuctions: () => () => undefined,
        onBuyable: () => () => undefined,
        onProbe: () => () => undefined,
        onShape: () => () => undefined,
      },
      getFilters: () => [],
      estimateSellPrice: async () => null,
      killSwitch: () => ({ active: false }),
      onChange: () => undefined,
    },
    DEFAULT_BOT_SETTINGS,
  );
  const waiting = { ...sniper.state, phase: 'waiting' as const, phaseEndsAt: Date.now() + 10_000 };
  vi.spyOn(sniper, 'state', 'get').mockReturnValue(waiting);

  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => sniper,
    getUnavailableReason: () => null,
    prepare: async () => undefined,
    getSettings: () => DEFAULT_BOT_SETTINGS,
    saveSettings: async () => undefined,
    setLiveSearch: () => undefined,
    resolveNames: async () => ({}),
    getCatalog: async () => null,
  });
  page.open();
  shadows.restore();
  const root = shadows.rootOf(document.getElementById('ledger-bot-page')!);
  // How far the arc has emptied, in degrees of rotation (0 full, 360 empty).
  const angle = (sel: string) => -Number(/rotate\((-?[\d.]+)deg\)/.exec((root.querySelector(sel) as HTMLElement).style.transform)?.[1] ?? 0);
  const offset = () => angle('.ring-l .ring-fill') + angle('.ring-r .ring-fill');
  const ring = root.querySelector('.ring-wrap');
  expect(ring).not.toBeNull();

  // Two frames apart, the arc has moved: not held for a 250 ms step.
  vi.advanceTimersByTime(100);
  const a = offset();
  vi.advanceTimersByTime(34);
  const b = offset();
  expect(b).toBeGreaterThan(a);

  vi.advanceTimersByTime(2_466);
  const beforeRefresh = offset();
  page.refresh(); // the dash is rebuilt on the next frame
  vi.advanceTimersByTime(20);
  expect(root.querySelector('.ring-wrap')).toBe(ring);
  expect(offset()).toBeGreaterThanOrEqual(beforeRefresh);
  // 10 s wait, 2.62 s gone: 7.38 s left.
  expect(root.querySelector('.ring-label .t')!.textContent).toBe('8s');
  page.close();
});
