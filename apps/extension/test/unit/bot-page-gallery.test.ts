// The Nova AI page's Gallery mode (`ui/bot-page.ts`): picking Gallery puts
// the list box and its budget in the search's place, Load list reads the
// pasted cards against EA's player list (saying which lines it could not
// read), the budget saves on its own, Start runs the list without a search,
// and the Gallery tab beside Search results shows where each card is.

import { DEFAULT_BOT_MODE_SETTINGS, DEFAULT_BOT_SETTINGS, type BotModeSettings, type GalleryState } from '@sl/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Sniper } from '../../src/engine/sniper.js';
import { createBotPage } from '../../src/ui/bot-page.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

import type { Catalog } from '../../src/model/catalog.js';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  trustTestEvents();
});
afterEach(() => {
  vi.useRealTimers();
  untrustedEvents();
});

const CATALOG: Catalog = {
  players: [
    { id: 257289, name: 'Hugo Ekitiké', rating: 85 },
    { id: 256630, name: 'Florian Wirtz', rating: 86 },
  ],
  levels: [],
  rarities: [],
  positions: [],
  playStyles: [],
  nations: [],
  leagues: [],
  clubs: {},
  capturedAt: 1,
};

function makeSniper(): Sniper {
  return new Sniper(
    {
      adapter: {
        search: vi.fn(),
        buy: vi.fn(),
        list: vi.fn(),
        move: vi.fn(),
        club: vi.fn(),
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
    { ...DEFAULT_BOT_SETTINGS, riskAcknowledgedAt: '2026-09-24T00:00:00.000Z' },
  );
}

async function mount(initialMode: BotModeSettings = DEFAULT_BOT_MODE_SETTINGS, initialGallery: GalleryState = { budget: 100_000, spent: 0, cards: [] }) {
  let mode = initialMode;
  let gallery = initialGallery;
  const saves: GalleryState[] = [];
  const sniper = makeSniper();
  sniper.setGallery(gallery);
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => sniper,
    getUnavailableReason: () => null,
    prepare: async () => undefined,
    getSettings: () => ({ ...DEFAULT_BOT_SETTINGS, riskAcknowledgedAt: '2026-09-24T00:00:00.000Z' }),
    saveSettings: async () => undefined,
    getModeSettings: () => mode,
    saveModeSettings: async (next) => {
      mode = next;
    },
    getGallery: () => (sniper.isRunning() ? sniper.getGallery() : gallery),
    saveGallery: async (next) => {
      gallery = next;
      sniper.setGallery(next);
      saves.push(next);
    },
    setLiveSearch: () => undefined,
    resolveNames: async () => ({}),
    getCatalog: async () => CATALOG,
  });
  page.open();
  shadows.restore();
  // The catalog arrives a tick after the page opens.
  await vi.advanceTimersByTimeAsync(10);
  const root = shadows.rootOf(document.getElementById('ledger-bot-page')!);
  const $ = (id: string) => root.getElementById(id) as HTMLInputElement | null;
  const click = (selector: string) => {
    (root.querySelector(selector) as HTMLElement).click();
    vi.advanceTimersByTime(1_000);
  };
  const shown = (id: string) => getComputedStyle(root.getElementById(id)!).display !== 'none';
  return { root, $, click, shown, sniper, page, saves, gallery: () => gallery };
}

it('puts the Gallery list and its budget in the search’s place once Gallery is picked', async () => {
  const { root, click, shown } = await mount();
  expect(shown('targets')).toBe(true);
  expect(shown('gallery')).toBe(false);
  expect((root.querySelector('.ftab[data-feed="gallery"]') as HTMLElement).hidden).toBe(true);
  click('[data-mode="gallery"]');
  expect(root.getElementById('settings')!.dataset.mode).toBe('gallery');
  expect(shown('targets')).toBe(false);
  expect(shown('recent')).toBe(false);
  expect(shown('gallery')).toBe(true);
  // The Gallery tab beside Search results shows, picked.
  const tab = root.querySelector('.ftab[data-feed="gallery"]') as HTMLElement;
  expect(tab.hidden).toBe(false);
  expect(tab.getAttribute('aria-selected')).toBe('true');
  expect(root.getElementById('gallery-feed')!.textContent).toContain('Paste your Gallery list on the left');
  expect(root.getElementById('run-status')!.textContent).toBe('Paste your Gallery list and press Load list to start');
});

it('loads the pasted list against EA’s player list and says which lines it could not read', async () => {
  const { root, $, click, saves } = await mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' });
  const box = $('g-list') as unknown as HTMLTextAreaElement;
  box.value = '# Ligue 1\nHugo Ekitiké 85\nNobody 80\nFlorian Wirtz 88';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  click('#g-load');
  expect(saves.at(-1)!.cards).toEqual([
    { key: '257289:85', name: 'Hugo Ekitiké', rating: 85, playerId: 257289, resourceId: 257289, status: 'todo', set: 'Ligue 1' },
    { key: '256630:88', name: 'Florian Wirtz', rating: 88, playerId: 256630, status: 'todo', set: 'Ligue 1' },
  ]);
  expect(root.getElementById('g-problems')!.textContent).toBe('Line 3: no player named "Nobody" in EA\'s player list');
  expect(root.getElementById('run-status')!.textContent).toBe('Buys 2 Gallery cards · 100,000 coins of budget left');
  const rows = [...root.querySelectorAll('#gallery-feed .bidrow')].map((r) => r.querySelector('.main b')!.textContent);
  expect(rows).toEqual(['85 Hugo Ekitiké', '88 Florian Wirtz']);
});

it('saves the budget on its own, and refuses one that is not a whole number of coins', async () => {
  const { $, saves } = await mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' });
  const budget = $('g-budget')!;
  budget.value = '250,000';
  budget.dispatchEvent(new Event('change', { bubbles: true }));
  expect(saves.at(-1)!.budget).toBe(250_000);
  const box = $('g-budget')!;
  box.value = 'lots';
  box.dispatchEvent(new Event('change', { bubbles: true }));
  expect(saves).toHaveLength(1);
  expect(box.getAttribute('aria-invalid')).toBe('true');
});

it('starts the list without a search, and shows each card’s progress', async () => {
  const gallery: GalleryState = {
    budget: 100_000,
    spent: 3_700,
    cards: [
      { key: '257289:85', name: 'Hugo Ekitiké', rating: 85, playerId: 257289, resourceId: 257289, status: 'listed', price: 3_700, market: 4_000, listPrice: 3_900 },
      { key: '256630:86', name: 'Florian Wirtz', rating: 86, playerId: 256630, resourceId: 256630, status: 'skipped', note: 'none listed at this rating right now' },
      { key: '1:80', name: 'Someone', rating: 80, playerId: 1, status: 'todo' },
    ],
  };
  const { root, click, sniper } = await mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' }, gallery);
  const start = vi.spyOn(sniper, 'start');
  const rows = [...root.querySelectorAll('#gallery-feed .bidrow')];
  expect(rows.map((r) => r.querySelector('.st')!.textContent)).toEqual(['Listed', 'Skipped', 'To buy']);
  expect(rows[0]!.textContent).toContain('3,700');
  expect(rows[0]!.textContent).toContain('3,900');
  expect(rows[1]!.textContent).toContain('none listed at this rating right now');
  expect(root.querySelector('#gallery-feed .bids-head')!.textContent).toBe('1 to buy · 1 listed · 0 on the way · 1 skipped · spent 3,700 of 100,000');
  click('#start');
  expect(start).toHaveBeenCalledTimes(1);
  expect(sniper.getRunMode()).toBe('gallery');
  sniper.stop('manual');
});

it('retries skipped cards and clears the list', async () => {
  const gallery: GalleryState = {
    budget: 100_000,
    spent: 500,
    cards: [{ key: '256630:86', name: 'Florian Wirtz', rating: 86, playerId: 256630, resourceId: 256630, status: 'skipped', note: 'none listed' }],
  };
  const { click, saves } = await mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' }, gallery);
  click('#g-retry');
  expect(saves.at(-1)!.cards[0]).toEqual({ key: '256630:86', name: 'Florian Wirtz', rating: 86, playerId: 256630, resourceId: 256630, status: 'todo' });
  click('#g-clear');
  expect(saves.at(-1)).toEqual({ budget: 100_000, spent: 0, cards: [] });
});
