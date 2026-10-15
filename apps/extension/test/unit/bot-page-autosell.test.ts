// The Nova AI page's Auto-sell settings (`ui/bot-page.ts`): off by default;
// turning it on, choosing market or fixed price, moving the price steps
// (negative too) and the fixed price along EA's grid all save.

import { DEFAULT_BOT_SETTINGS, type BotSettings } from '@sl/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createBotPage, saleProfit } from '../../src/ui/bot-page.js';

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
  const type = (id: string, text: string) => {
    const input = root.getElementById(id) as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    vi.advanceTimersByTime(1_000);
  };
  const profit = () => root.getElementById('nf-profit')!.textContent!.replace(/\s+/g, ' ').trim();
  return { root, click, value, type, profit, saved: () => stored.autoSell };
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
  // The fixed price is set in Search, right under the max buy price.
  expect(value('nf-sell')).toBe('10,000');
  // 10,000 up one EA step is 10,250.
  click('[data-sell-step="1"]');
  expect(value('nf-sell')).toBe('10,250');
  expect(saved().fixedPrice).toBe(10_250);
  expect(saved().steps).toBe(-2); // kept for when market price comes back

  click('#as-noloss');
  expect(saved().noLoss).toBe(false);
});

it("works out a sale's tax and profit with the app's one profit formula", () => {
  expect(saleProfit(1_500, 1_200)).toEqual({ tax: 75, net: 1_425, profit: 225 });
  expect(saleProfit(1_500, 1_450)).toEqual({ tax: 75, net: 1_425, profit: -25 });
  expect(saleProfit(54_000, null)).toEqual({ tax: 2_700, net: 51_300, profit: null });
});

it('sits the sell price right under the max buy price and shows what each card makes', () => {
  const { root, type, value, profit, saved } = mount();
  // Max buy and sell are neighbours in the Search card.
  const rows = [...root.querySelectorAll('#ea-search .price input')].map((i) => i.id);
  expect(rows).toEqual(['nf-minBuy', 'nf-maxBuy', 'nf-sell']);
  // Until a price is typed, it sells at the FUTBIN price.
  expect(value('nf-sell')).toBe('');
  expect(profit()).toContain('Sells at the FUTBIN price');

  type('nf-maxBuy', '1200');
  type('nf-sell', '1500');
  expect(saved()).toMatchObject({ mode: 'fixed', fixedPrice: 1_500 });
  expect(profit()).toContain("You get 1,425 after EA's 5% tax (75)");
  expect(profit()).toContain('Profit +225 per card at your max buy (1,200)');
  // Auto-sell is off by default: the line says so.
  expect(profit()).toContain('Auto-sell is off');

  // A loss shows as one.
  type('nf-maxBuy', '1450');
  expect(profit()).toContain('Profit −25 per card');

  // Off EA's grid is put on it (1,000-10,000 moves in 100s).
  type('nf-sell', '1520');
  expect(value('nf-sell')).toBe('1,500');

  // Cleared: back to the FUTBIN price.
  type('nf-sell', '');
  expect(saved().mode).toBe('market');
  expect(profit()).toContain('Sells at the FUTBIN price');
});
