// The Nova AI page's search (`ui/bot-page.ts`): there is no "Add Target"
// step — Start runs the bot on the search as it is filled in, handed over
// through `setLiveSearch` (never the saved filters), and edits while running
// reach the bot's next search. The Start bar lives under the settings.

import { DEFAULT_BOT_SETTINGS } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sniper, type SniperFilter } from '../../src/engine/sniper.js';
import {
  LIVE_SEARCH_ID,
  blankForm,
  buildFilterFromForm,
  createBotPage,
  type LiveSearch,
} from '../../src/ui/bot-page.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

describe('buildFilterFromForm', () => {
  it('searches a picked player', () => {
    const form = { ...blankForm(), player: { id: 20801, name: 'Cristiano Ronaldo', rating: 86 } };
    expect(buildFilterFromForm(form)).toEqual({ filter: { resourceId: 20801 } });
  });

  it('accepts a typed player id, and rejects a typed name that was not picked', () => {
    expect(buildFilterFromForm({ ...blankForm(), playerQuery: ' 20801 ' })).toEqual({ filter: { resourceId: 20801 } });
    expect(buildFilterFromForm({ ...blankForm(), playerQuery: 'Ronaldo' })).toEqual({
      error: 'Pick a player from the list, or type their id',
    });
  });

  it('searches filters alone, without a player', () => {
    const form = { ...blankForm(), minOvr: 84, position: 'ST', rarity: 3, maxBuy: 15_000 };
    expect(buildFilterFromForm(form)).toEqual({
      filter: { minRating: 84, position: 'ST', rarity: 3, maxPrice: 15_000 },
    });
    // A position group searches as a zone, like EA's own panel.
    expect(buildFilterFromForm({ ...blankForm(), position: '131' })).toEqual({ filter: { zone: 131 } });
  });

  it('needs a player or at least one filter', () => {
    expect(buildFilterFromForm(blankForm())).toEqual({ error: 'Pick a player or at least one filter' });
  });

  it('rejects a min price above the max price', () => {
    expect(buildFilterFromForm({ ...blankForm(), minBuy: 20_000, maxBuy: 10_000 })).toEqual({
      error: 'Min price is above max price',
    });
  });
});

function makeSniper(getFilters: () => SniperFilter[]): Sniper {
  return new Sniper(
    {
      adapter: {
        search: vi.fn(async () => ({ ok: true as const, auctions: [] })),
        buy: vi.fn(),
        onAuctions: () => () => undefined,
        onProbe: () => () => undefined,
        onShape: () => () => undefined,
      } as never,
      getFilters,
      estimateSellPrice: async () => null,
      killSwitch: () => ({ active: false }),
      onChange: () => undefined,
    },
    DEFAULT_BOT_SETTINGS,
  );
}

function mount() {
  // Wired the way content/index.ts wires it: the bot reads the live search.
  let live: LiveSearch | null = null;
  const sniper = makeSniper(() => (live ? [live] : []));
  const start = vi.spyOn(sniper, 'start');
  const deps = {
    getSniper: () => sniper,
    getUnavailableReason: () => null,
    prepare: async () => undefined,
    getSettings: () => DEFAULT_BOT_SETTINGS,
    saveSettings: vi.fn(async () => undefined),
    setLiveSearch: (s: LiveSearch | null) => {
      live = s;
    },
    resolveNames: async () => ({}),
    getCatalog: async () => null,
  };
  const shadows = captureShadowRoots();
  const page = createBotPage(deps);
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
  return { page, root, $, sniper, start, deps, live: () => live, typePlayer, setPrice };
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

describe('bot page — Start runs the search on the page', () => {
  it('has no Add Target button and no saved-target list', () => {
    const { $, root } = mount();
    expect($('nf-add')).toBeNull();
    expect($('nf-name')).toBeNull();
    expect(root.querySelector('[data-remove]')).toBeNull();
    expect(root.textContent).not.toContain('Add Target');
  });

  it('puts Start in the bar under the settings, not in the header', () => {
    const { $, root } = mount();
    expect($('start')!.closest('.runbar')).not.toBeNull();
    expect($('start')!.closest('#settings')).not.toBeNull();
    expect(root.querySelector('.top #start')).toBeNull();
    expect($('reset')!.closest('.live')).not.toBeNull();
  });

  it('does not start with an empty search, and says why', () => {
    const { $, start } = mount();
    $('start')!.click();
    expect(start).not.toHaveBeenCalled();
    expect($('saved')!.textContent).toBe('Pick a player or at least one filter');
    expect($('run-status')!.textContent).toBe('Pick a player or at least one filter');
  });

  it('starts on the filled-in search and hands it to the bot, not to the saved filters', () => {
    const { $, start, deps, live, typePlayer, setPrice } = mount();
    typePlayer('20801');
    setPrice('maxBuy', '15000');
    $('start')!.click();
    expect(start).toHaveBeenCalledTimes(1);
    expect(live()).toMatchObject({ id: LIVE_SEARCH_ID, filter: { resourceId: 20801, maxPrice: 15_000 } });
    // The page's deps have no way to save filters at all.
    expect(Object.keys(deps)).not.toContain('saveFilters');
  });

  it('applies an edit made while running to the next search', () => {
    const { $, sniper, live, setPrice, typePlayer } = mount();
    typePlayer('20801');
    $('start')!.click();
    vi.spyOn(sniper, 'isRunning').mockReturnValue(true);
    setPrice('maxBuy', '9000');
    expect(live()!.filter).toEqual({ resourceId: 20801, maxPrice: 9_000 });
    // An unfinished edit keeps the last complete search running.
    typePlayer('Ronal');
    expect(live()!.filter).toEqual({ resourceId: 20801, maxPrice: 9_000 });
    expect($('run-status')!.textContent).toContain('Search not updated');
  });
});
