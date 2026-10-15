// The Nova AI page's Auto-sell settings (`ui/bot-page.ts`): off by default;
// turning it on, choosing market or fixed price, moving the price steps
// (negative too) and the fixed price along EA's grid all save.

import { DEFAULT_BOT_SETTINGS, type BotSettings } from '@sl/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

function mount() {
  let stored: BotSettings = DEFAULT_BOT_SETTINGS;
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => null,
    getUnavailableReason: () => 'test',
    prepare: async () => undefined,
    getSettings: () => stored,
    saveSettings: async (next) => {
      stored = next;
    },
    setLiveSearch: () => undefined,
    resolveNames: async () => ({}),
    getCatalog: async () => null,
  });
  page.open();
  shadows.restore();
  const root = shadows.rootOf(document.getElementById('ledger-bot-page')!);
  const click = (selector: string) => {
    (root.querySelector(selector) as HTMLElement).click();
    vi.advanceTimersByTime(1_000); // the debounced save
  };
  const value = (id: string) => (root.getElementById(id) as HTMLInputElement | null)?.value;
  return { root, click, value, saved: () => stored.autoSell };
}

it('turns on, steps the market price down, and switches to a fixed price on the grid', () => {
  const { click, value, saved } = mount();
  expect(saved().enabled).toBe(false);

  click('#as-on');
  expect(saved().enabled).toBe(true);

  // Below zero: steps under the market price.
  click('[data-step="as-steps"][data-dir="-1"]');
  click('[data-step="as-steps"][data-dir="-1"]');
  expect(value('as-steps')).toBe('-2');
  expect(saved().steps).toBe(-2);

  click('[data-as-platform="pc"]');
  expect(saved().platform).toBe('pc');

  click('[data-as-mode="fixed"]');
  expect(saved().mode).toBe('fixed');
  expect(value('as-steps')).toBeUndefined(); // only the fixed price shows now
  // 10,000 up one EA step is 10,250.
  click('[data-step="as-price"][data-dir="1"]');
  expect(value('as-price')).toBe('10250');
  expect(saved().fixedPrice).toBe(10_250);
  expect(saved().steps).toBe(-2); // kept for when market price comes back

  click('#as-noloss');
  expect(saved().noLoss).toBe(false);
});
