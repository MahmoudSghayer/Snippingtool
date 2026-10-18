// The Nova AI page laid out like EA's "Search the Transfer Market" screen
// (`ui/bot-page.ts`): the Search / Settings tab row, each price section's
// own "Clear", EA's Reset beside the Start button, and Start taking the
// user to the risk confirmation on the Settings tab.

import { DEFAULT_BOT_SETTINGS, botRiskLevel, type BotSettings } from '@sl/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Sniper, type SniperLogEntry, type SniperState } from '../../src/engine/sniper.js';
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

function makeSniper(settings: BotSettings): Sniper {
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
    settings,
  );
}

function mount(initial: BotSettings = DEFAULT_BOT_SETTINGS) {
  let stored = initial;
  const sniper = makeSniper(initial);
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => sniper,
    getUnavailableReason: () => null,
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
  const $ = (id: string) => root.getElementById(id) as HTMLInputElement | null;
  const click = (selector: string) => {
    (root.querySelector(selector) as HTMLElement).click();
    vi.advanceTimersByTime(1_000);
  };
  const type = (id: string, text: string) => {
    const input = $(id)!;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    vi.advanceTimersByTime(1_000);
  };
  const tab = () => $('settings')!.dataset.tab;
  return { root, $, click, type, tab, sniper, page, saved: () => stored };
}

it('switches between the search and the settings with the tab row', () => {
  const { root, click, tab } = mount();
  expect(tab()).toBe('search');
  expect(root.querySelector('[data-tab="search"][role="tab"]')!.getAttribute('aria-selected')).toBe('true');

  click('[data-tab="settings"][role="tab"]');
  expect(tab()).toBe('settings');
  expect(root.querySelector('[data-tab="settings"][role="tab"]')!.getAttribute('aria-selected')).toBe('true');
  expect(root.querySelector('[data-tab="search"][role="tab"]')!.getAttribute('aria-selected')).toBe('false');

  click('[data-tab="search"][role="tab"]');
  expect(tab()).toBe('search');
});

it("lays the dropdowns out two to a row and the prices as EA's Min: and Max: columns", () => {
  const { root } = mount();
  expect(root.querySelectorAll('#ea-search .dd-grid .dd')).toHaveLength(7);
  const heads = [...root.querySelectorAll('#ea-search .sec-h > span')].map((e) => e.textContent);
  expect(heads).toEqual(['Rating:', 'Buy Now Price:', 'Sell Price:']);
  const labels = [...root.querySelectorAll('#ea-search .mm-k')].map((e) => e.textContent);
  expect(labels).toEqual(['Min:', 'Max:', 'Min:', 'Max:', 'Sell at:']);
  // Reset sits beside Start, as on EA's panel.
  expect(root.getElementById('nf-reset')!.closest('.run-actions')).toBe(root.getElementById('start')!.closest('.run-actions'));
});

it("clears one price section with its own Clear, and leaves the others", () => {
  const { $, click, type, saved } = mount();
  type('nf-minBuy', '1000');
  type('nf-maxBuy', '2200');
  type('nf-sell', '1700');
  expect(saved().autoSell).toMatchObject({ mode: 'fixed', fixedPrice: 1_700 });

  click('[data-clear-sec="buy"]');
  expect($('nf-minBuy')!.value).toBe('');
  expect($('nf-maxBuy')!.value).toBe('');
  expect($('nf-sell')!.value).toBe('1,700');

  click('[data-clear-sec="sell"]');
  expect($('nf-sell')!.value).toBe('');
  expect(saved().autoSell.mode).toBe('market');
});

it('puts the rating back to the full range with its Clear', () => {
  const { $, click, type } = mount();
  type('nf-minovr', '84');
  type('nf-maxovr', '86');
  click('[data-clear-sec="ovr"]');
  expect($('nf-minovr')!.value).toBe('45');
  expect($('nf-maxovr')!.value).toBe('99');
});

it('empties the whole search with Reset, back on the Search tab', () => {
  const { $, click, type, tab } = mount();
  type('nf-maxBuy', '2200');
  click('[data-tab="settings"][role="tab"]');
  click('#nf-reset');
  expect(tab()).toBe('search');
  expect($('nf-maxBuy')!.value).toBe('');
});

it('takes the user to the Settings tab when Start waits on the risk confirmation', () => {
  const risky: BotSettings = { ...DEFAULT_BOT_SETTINGS, searchDelay: { min: 1, max: 2 }, riskAcknowledgedAt: null };
  expect(botRiskLevel(risky).level).not.toBe('low');
  const { $, click, tab, sniper } = mount(risky);
  expect(($('start') as unknown as HTMLButtonElement).disabled).toBe(true);
  expect($('run-status')!.textContent).toBe('Confirm the risk level on the Settings tab to start');
  click('#run-status');
  expect(sniper.isRunning()).toBe(false);
  expect(tab()).toBe('settings');
});

it('leaves the status line alone when Start is ready', () => {
  const { click, tab } = mount();
  click('#run-status');
  expect(tab()).toBe('search');
});

it('shows the pace the bot searches at, and when the hourly limit will pause it', () => {
  const { $, type } = mount();
  // The recommended 8-12 s is 360 searches an hour, over the 250 limit.
  expect($('pace')!.textContent).toBe(
    'This delay would make about 360 searches an hour, over your limit of 250: Nova AI pauses after about 42 minutes of searching each hour, so it searches about 250 times an hour.',
  );
  type('delay', '20');
  expect($('pace')!.textContent).toBe('About 180 searches an hour at this delay (your limit is 250).');
});

it('says which hourly limit holds buying back, and when it frees', () => {
  const { $, sniper, page } = mount();
  const notice = 'Buying paused: coin-flow limit (412,000 of 500,000 coins in the last hour) — resumes about 02:14';
  const state: SniperState = { phase: 'blocked', phaseEndsAt: Date.now() + 60_000, stopReason: null, stopDetail: null, notice };
  vi.spyOn(sniper, 'state', 'get').mockReturnValue(state);
  vi.spyOn(sniper, 'isRunning').mockReturnValue(true);
  page.refresh();
  vi.advanceTimersByTime(100);
  const status = $('run-status')!;
  expect(status.textContent).toBe(notice);
  expect(status.classList.contains('bad')).toBe(true);
  expect(status.classList.contains('wrap')).toBe(true);
  expect($('phase')!.textContent).toBe('Buying paused');
  expect($('phase')!.title).toBe(notice);
});

it('shows how fast the bot went for a listing it bought or missed', () => {
  const { $, sniper, page } = mount();
  const at = Date.now();
  const log: SniperLogEntry[] = [
    { id: 2, at, kind: 'failed', resourceId: 100, assetId: 100, rating: 85, price: 8_000, reactionMs: 7, message: 'someone else got it first' },
    { id: 1, at, kind: 'bought', resourceId: 100, assetId: 100, rating: 85, price: 8_000, sellPrice: null, profit: null, reactionMs: 1_042, message: 'bought' },
  ];
  vi.spyOn(sniper, 'getLog').mockReturnValue(log);
  page.refresh();
  vi.advanceTimersByTime(100);
  const text = $('log')!.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain('someone else got it first, reacted in 7 ms');
  expect(text).toContain('reacted in 1,042 ms');
});
