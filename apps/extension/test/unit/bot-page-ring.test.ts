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

it('counts a wait down every frame, and a dash refresh does not restart it', () => {
  const sniper = new Sniper(
    {
      adapter: {
        search: vi.fn(),
        buy: vi.fn(),
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
