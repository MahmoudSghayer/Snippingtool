// The Nova AI page's Gallery mode (`ui/bot-page.ts`): picking Gallery puts
// the list box and its budget in the search's place, Load list reads the
// pasted cards against EA's player list (saying which lines it could not
// read), the budget saves on its own, Start runs the list without a search,
// and the Gallery tab beside Search results shows where each card is. The
// fut.gg picker lists fut.gg's Sets (grade S only, by default), puts the
// ticked Sets' lineups on the list and asks the club which cards it holds.

import {
  DEFAULT_BOT_MODE_SETTINGS,
  DEFAULT_BOT_SETTINGS,
  type BotModeSettings,
  type FutggLineup,
  type FutggSetSummary,
  type GalleryGrade,
  type GalleryState,
} from '@sl/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Sniper } from '../../src/engine/sniper.js';
import { createBotPage } from '../../src/ui/bot-page.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

import type { ActionOutcome } from '../../src/content/adapter-client.js';
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
  rarities: [
    { id: 1, value: '1', label: 'Rare' },
    { id: 52, value: '52', label: 'Signature' },
  ],
  positions: [],
  playStyles: [],
  nations: [],
  leagues: [],
  clubs: {},
  capturedAt: 1,
};

function makeSniper(owned?: (ids: number[]) => Promise<ActionOutcome>): Sniper {
  return new Sniper(
    {
      adapter: {
        search: vi.fn(),
        buy: vi.fn(),
        list: vi.fn(),
        move: vi.fn(),
        club: vi.fn(),
        ...(owned ? { owned } : {}),
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

interface Futgg {
  sets: FutggSetSummary[] | null;
  lineup: (setId: number, grade: GalleryGrade) => FutggLineup | null;
  owned?: (ids: number[]) => Promise<ActionOutcome>;
}

async function mount(
  initialMode: BotModeSettings = DEFAULT_BOT_MODE_SETTINGS,
  initialGallery: GalleryState = { budget: 100_000, spent: 0, cards: [] },
  futgg?: Futgg,
) {
  let mode = initialMode;
  let gallery = initialGallery;
  const saves: GalleryState[] = [];
  const sniper = makeSniper(futgg?.owned);
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
    // As content/index.ts: the bot's copy (the page saves into it).
    getGallery: () => sniper.getGallery(),
    saveGallery: async (next) => {
      gallery = next;
      sniper.setGallery(next);
      saves.push(next);
    },
    ...(futgg
      ? {
          futggSets: async () => futgg.sets,
          futggLineup: async (setId: number, grade: GalleryGrade) => futgg.lineup(setId, grade),
        }
      : {}),
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
  expect(root.getElementById('run-status')!.textContent).toBe('Add fut.gg Sets, or paste your Gallery list and press Load list, to start');
});

it('loads the pasted list against EA’s player list and says which lines it could not read', async () => {
  const { root, $, click, saves } = await mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' });
  const box = $('g-list') as unknown as HTMLTextAreaElement;
  box.value = '# Ligue 1\nHugo Ekitiké 85\nNobody 80\nFlorian Wirtz 88\nHugo Ekitiké 85 Signature';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  click('#g-load');
  expect(saves.at(-1)!.cards).toEqual([
    { key: '257289:85', name: 'Hugo Ekitiké', rating: 85, playerId: 257289, resourceId: 257289, status: 'todo', set: 'Ligue 1' },
    { key: '256630:88', name: 'Florian Wirtz', rating: 88, playerId: 256630, status: 'todo', set: 'Ligue 1' },
    { key: '257289:85:52', name: 'Hugo Ekitiké', rating: 85, playerId: 257289, status: 'todo', set: 'Ligue 1', rarity: 52, version: 'Signature' },
  ]);
  expect(root.getElementById('g-problems')!.textContent).toBe('Line 3: no player named "Nobody" in EA\'s player list');
  expect(root.getElementById('run-status')!.textContent).toBe('Buys 3 Gallery cards · 100,000 coins of budget left');
  const rows = [...root.querySelectorAll('#gallery-feed .bidrow')].map((r) => r.querySelector('.main b')!.textContent);
  expect(rows).toEqual(['85 Hugo Ekitiké', '88 Florian Wirtz', '85 Hugo Ekitiké']);
  expect(root.querySelectorAll('#gallery-feed .bidrow')[2]!.textContent).toContain('Signature');
  // The box shows the version back, so a reload of the text keeps it.
  expect(($('g-list') as unknown as HTMLTextAreaElement).value).toContain('Hugo Ekitiké 85 Signature');
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

const tier = (grade: GalleryGrade, cost: number) => ({ grade, threshold: grade === 'S' ? 900 : 300, tokens: grade === 'S' ? 28 : 0, cost, peak: 3_100, score: 908, cards: 2 });
const MALAGA: FutggSetSummary = { id: 90, name: 'Malaga CF', category: 'LALIGA EA SPORTS / Liga F Moeve', path: 'laliga/malaga-cf', requiredCards: 15, tiers: [tier('C', 13_250), tier('S', 20_850)] };
const FROSINONE: FutggSetSummary = { ...MALAGA, id: 91, name: 'Frosinone', category: 'Serie A Enilive', path: 'serie-a/frosinone', tiers: [tier('S', 19_600)] };
const ARSENAL: FutggSetSummary = { ...MALAGA, id: 30, name: 'Arsenal', category: 'Premier League / Barclays WSL', path: 'premier-league/arsenal', tiers: [tier('C', 63_500)] };
const MALAGA_S: FutggLineup = {
  set: MALAGA,
  grade: 'S',
  missing: 0,
  cards: [
    { resourceId: 243312, playerId: 243312, name: 'Dani Lorenzo', rating: 74, rarity: 0, version: 'Rare', holographic: false, score: 60, price: 3_100 },
    { resourceId: 50_574_721, playerId: 243_073, name: 'Kevin', rating: 76, rarity: 3, version: 'Team of the week', holographic: true, score: 225, price: 1_400 },
  ],
};

it("lists fut.gg's grade S Sets cheapest first, adds the ticked ones, and leaves out cards the club holds", async () => {
  const owned = vi.fn(async (_ids: number[]) => ({ ok: true, owned: [243312], latencyMs: 5 }));
  const lineup = vi.fn((setId: number, grade: GalleryGrade) => (setId === 90 && grade === 'S' ? MALAGA_S : null));
  const { root, $, click, sniper } = await mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' }, undefined, { sets: [MALAGA, ARSENAL, FROSINONE], lineup, owned });
  click('#g-futgg');
  await vi.advanceTimersByTimeAsync(10);
  const names = () => [...root.querySelectorAll('.g-set')].map((r) => r.querySelector('.nm')!.childNodes[0]!.textContent);
  expect(names()).toEqual(['Frosinone', 'Malaga CF']);
  expect(root.querySelector('.g-set')!.textContent).toContain('19,600');
  expect(root.querySelector('.g-set')!.textContent).toContain('28 tokens');
  // Every Set with a lineup, grade S first.
  const sOnly = $('g-sonly')!;
  sOnly.checked = false;
  sOnly.dispatchEvent(new Event('change', { bubbles: true }));
  expect(names()).toEqual(['Frosinone', 'Malaga CF', 'Arsenal']);
  $('g-sonly')!.checked = true;
  $('g-sonly')!.dispatchEvent(new Event('change', { bubbles: true }));

  const tick = root.querySelector('input[data-futgg="90"]') as HTMLInputElement;
  tick.checked = true;
  tick.dispatchEvent(new Event('change', { bubbles: true }));
  expect(root.getElementById('g-add')!.textContent).toBe('Add 1 Set');
  click('#g-add');
  await vi.advanceTimersByTimeAsync(10);
  expect(lineup).toHaveBeenCalledWith(90, 'S');
  expect(owned).toHaveBeenCalledWith([243312, 50_574_721]);
  const g = sniper.getGallery();
  expect(g.cards.map((c) => [c.name, c.status, c.exact])).toEqual([
    ['Dani Lorenzo', 'owned', true],
    ['Kevin', 'todo', true],
  ]);
  expect(g.sets!.map((x) => [x.name, x.grade, x.cost])).toEqual([['Malaga CF', 'S', 20_850]]);
  expect(root.getElementById('saved')!.textContent).toBe('Added 1 Set: 2 cards · 1 in your club already');
  // On the list now: ticked and locked in the picker, with its progress.
  expect((root.querySelector('input[data-futgg="90"]') as HTMLInputElement).disabled).toBe(true);
  expect(root.querySelector('.g-mineset')!.textContent).toContain('Malaga CF · grade S · 1 of 2 collected');
  expect(root.querySelector('#gallery-feed .g-sethead')!.textContent).toBe("Malaga CF · grade S needs 900 points, fut.gg's lineup makes 908 · 1 of 2 collected");
  expect(root.querySelectorAll('#gallery-feed .bidrow')[1]!.textContent).toContain('fut.gg price 1,400');
  expect(root.querySelectorAll('#gallery-feed .bidrow')[0]!.querySelector('.st')!.textContent).toBe('In your club');

  // The box holds the typed cards only, and Load list keeps fut.gg's.
  const box = $('g-list') as unknown as HTMLTextAreaElement;
  expect(box.value).toBe('');
  box.value = 'Hugo Ekitiké 85';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  click('#g-load');
  expect(sniper.getGallery().cards.map((c) => c.name)).toEqual(['Dani Lorenzo', 'Kevin', 'Hugo Ekitiké']);

  // Removing the Set takes its cards off the list.
  click('[data-remove-set="90"]');
  expect(sniper.getGallery().cards.map((c) => c.name)).toEqual(['Hugo Ekitiké']);
  expect(sniper.getGallery().sets).toBeUndefined();
});

it('says when fut.gg cannot be reached', async () => {
  const { root, click } = await mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' }, undefined, { sets: null, lineup: () => null });
  click('#g-futgg');
  await vi.advanceTimersByTimeAsync(10);
  expect(root.getElementById('g-futgg-problems')!.textContent).toBe('fut.gg could not be reached: try again in a minute');
});

it('says when fut.gg sends no lineup for a Set, and adds nothing', async () => {
  const other = await mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'gallery' }, undefined, { sets: [MALAGA], lineup: () => null });
  other.click('#g-futgg');
  await vi.advanceTimersByTimeAsync(10);
  const tick = other.root.querySelector('input[data-futgg="90"]') as HTMLInputElement;
  tick.checked = true;
  tick.dispatchEvent(new Event('change', { bubbles: true }));
  other.click('#g-add');
  await vi.advanceTimersByTimeAsync(10);
  expect(other.root.getElementById('g-futgg-problems')!.textContent).toBe('Malaga CF: fut.gg did not send its lineup — try again');
  expect(other.sniper.getGallery().cards).toEqual([]);
});
