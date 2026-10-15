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

it('hands each wait to the browser as one animation, and a refresh neither restarts it nor rebuilds the dash', () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
  (SVGElement.prototype as unknown as { animate: unknown }).animate = animate;
  try {
    const sniper = makeSniper();
    let state = { ...sniper.state, phase: 'waiting' as const, phaseEndsAt: Date.now() + 10_000 };
    vi.spyOn(sniper, 'state', 'get').mockImplementation(() => state);
    const { page, root } = mountPage(sniper);

    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(frames[0]).toEqual({ strokeDashoffset: '0px' });
    expect(timing).toMatchObject({ duration: 10_000, easing: 'linear', fill: 'forwards' });

    const searches = root.getElementById('d-searches');
    vi.advanceTimersByTime(3_000);
    page.refresh();
    vi.advanceTimersByTime(20);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(root.getElementById('d-searches')).toBe(searches);

    // The next wait gets its own animation.
    state = { ...state, phaseEndsAt: Date.now() + 8_000 };
    vi.advanceTimersByTime(20);
    expect(animate).toHaveBeenCalledTimes(2);
    page.close();
  } finally {
    delete (SVGElement.prototype as unknown as { animate?: unknown }).animate;
  }
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
  const offset = () => Number(root.querySelector('.ring .arc')!.getAttribute('stroke-dashoffset'));
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
