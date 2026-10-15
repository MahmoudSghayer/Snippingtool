// The Nova AI page's recent-searches log (`ui/bot-page.ts`): every search
// the bot is started on is listed, newest first, and clicking one fills the
// search in again. Nothing to save or name; kept between page loads through
// `deps.recentSearches`.

import { DEFAULT_BOT_SETTINGS } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sniper } from '../../src/engine/sniper.js';
import {
  MAX_RECENT_SEARCHES,
  addRecentSearch,
  blankForm,
  createBotPage,
  parseRecentSearches,
  type LiveSearch,
  type RecentSearch,
} from '../../src/ui/bot-page.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

const deJong = { id: 228702, name: 'Frenkie de Jong', rating: 86 };
const entry = (at: number, maxBuy: number): RecentSearch => ({
  at,
  name: `86 Frenkie de Jong, max ${maxBuy}`,
  form: { ...blankForm(), player: deJong, maxBuy },
});

describe('addRecentSearch', () => {
  it('puts the newest first, and moves a repeated search up instead of listing it twice', () => {
    let list = addRecentSearch([], entry(1, 52_000));
    list = addRecentSearch(list, entry(2, 50_000));
    list = addRecentSearch(list, entry(3, 52_000));
    expect(list.map((r) => r.at)).toEqual([3, 2]);
  });

  it(`keeps the last ${MAX_RECENT_SEARCHES}`, () => {
    let list: RecentSearch[] = [];
    for (let i = 1; i <= MAX_RECENT_SEARCHES + 3; i++) list = addRecentSearch(list, entry(i, i * 1_000));
    expect(list).toHaveLength(MAX_RECENT_SEARCHES);
    expect(list[0]!.at).toBe(MAX_RECENT_SEARCHES + 3);
  });
});

describe('parseRecentSearches', () => {
  it('reads back what was stored', () => {
    const stored = [entry(2, 50_000), entry(1, 52_000)];
    expect(parseRecentSearches(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it('drops anything that is not a search, and blanks fields of the wrong type', () => {
    expect(parseRecentSearches('nope')).toEqual([]);
    const parsed = parseRecentSearches([
      null,
      { at: 'x', name: 'n', form: {} },
      { at: 1, name: 'empty', form: {} }, // no player, no filter: not a search
      { at: 2, name: 'ok', form: { player: deJong, maxBuy: '52000', minOvr: 10, league: 13 } },
    ]);
    expect(parsed).toEqual([{ at: 2, name: 'ok', form: { ...blankForm(), player: deJong, league: 13 } }]);
  });
});

function mount(stored: unknown = undefined) {
  let live: LiveSearch | null = null;
  let running = false;
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
      } as never,
      getFilters: () => (live ? [live] : []),
      estimateSellPrice: async () => null,
      killSwitch: () => ({ active: false }),
      onChange: () => undefined,
    },
    DEFAULT_BOT_SETTINGS,
  );
  vi.spyOn(sniper, 'isRunning').mockImplementation(() => running);
  vi.spyOn(sniper, 'start').mockImplementation(() => void (running = true));
  vi.spyOn(sniper, 'stop').mockImplementation(() => void (running = false));
  const save = vi.fn(async (_list: RecentSearch[]) => undefined);
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => sniper,
    getUnavailableReason: () => null,
    prepare: async () => undefined,
    getSettings: () => DEFAULT_BOT_SETTINGS,
    saveSettings: async () => undefined,
    setLiveSearch: (s) => {
      live = s;
    },
    resolveNames: async () => ({}),
    getCatalog: async () => null,
    recentSearches: { load: async () => stored, save },
  });
  page.open();
  shadows.restore();
  const root = shadows.rootOf(document.getElementById('ledger-bot-page')!);
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T | null;
  const typePlayer = (value: string) => {
    const input = $<HTMLInputElement>('nf-player')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setPrice = (key: 'minBuy' | 'maxBuy', value: string) => {
    const input = $<HTMLInputElement>(`nf-${key}`)!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const recent = () => [...root.querySelectorAll<HTMLElement>('[data-recent]')];
  return { root, $, live: () => live, save, typePlayer, setPrice, recent };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  trustTestEvents();
});
afterEach(() => {
  vi.useRealTimers();
  untrustedEvents();
});

describe('the Recent searches log', () => {
  it('lists each search the bot is started on, and a click fills it in again', () => {
    const { $, live, save, typePlayer, setPrice, recent } = mount();
    expect(recent()).toHaveLength(0);

    typePlayer('20801');
    setPrice('maxBuy', '52000');
    $('start')!.click(); // start
    $('start')!.click(); // stop
    typePlayer('');
    setPrice('maxBuy', '');
    setPrice('minBuy', '1000');
    typePlayer('31432');
    $('start')!.click();
    $('start')!.click();

    expect(recent().map((b) => b.querySelector('.rc-name')!.textContent)).toEqual([
      'Player #31432, min 1,000, no max price',
      'Player #20801, max 52,000',
    ]);
    expect(save).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: 'Player #31432, min 1,000, no max price' }),
      expect.objectContaining({ name: 'Player #20801, max 52,000' }),
    ]);

    // Clear the search, then pick the older one: every field comes back,
    // and the bot would run it.
    $('nf-reset')!.click();
    recent()[1]!.click();
    expect($<HTMLInputElement>('nf-player')!.value).toBe('20801');
    expect($<HTMLInputElement>('nf-maxBuy')!.value).toBe('52,000');
    expect($<HTMLInputElement>('nf-minBuy')!.value).toBe('');
    expect(live()!.filter).toEqual({ resourceId: 20801, maxPrice: 52_000 });
  });

  it('shows the log kept from earlier page loads', async () => {
    const { recent, root } = mount(JSON.parse(JSON.stringify([entry(Date.now() - 60_000, 52_000)])));
    await vi.waitFor(() => expect(recent()).toHaveLength(1));
    expect(root.querySelector('.rc-name')!.textContent).toBe('86 Frenkie de Jong, max 52000');
    recent()[0]!.click();
    expect(root.querySelector('.picked b')!.textContent).toBe('Frenkie de Jong');
  });
});
