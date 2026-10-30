// How the Nova AI page (`ui/bot-page.ts`) gets EA's catalog: asked for once
// on open (nothing while hidden), then pushed by the web app through
// `deps.onCatalog` — never polled — and drawn without pulling the search
// form out from under the user; and the per-second tick runs only while the
// page is open and the tab can be seen.

import { DEFAULT_BOT_SETTINGS } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBotPage, type BotPageDeps } from '../../src/ui/bot-page.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

import type { Catalog } from '../../src/model/catalog.js';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  trustTestEvents();
  // jsdom has no scrollIntoView (an open list focuses its choice with it).
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  vi.useRealTimers();
  untrustedEvents();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

const catalog = (capturedAt: number, players = 2): Catalog => ({
  players: Array.from({ length: players }, (_, i) => ({ id: 1000 + i, name: `Player ${i}`, rating: 80 })),
  levels: [],
  rarities: [],
  positions: [],
  playStyles: [],
  nations: [{ id: 1, value: '1', label: 'France' }],
  leagues: [],
  clubs: {},
  capturedAt,
});

function mount(initial: Catalog | null, extra: Partial<BotPageDeps> = {}) {
  const getCatalog = vi.fn(async () => initial);
  let push: ((c: Catalog) => void) | null = null;
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => null,
    getUnavailableReason: () => 'Sign in to Nova Trade to use Nova AI.',
    prepare: async () => undefined,
    getSettings: () => DEFAULT_BOT_SETTINGS,
    saveSettings: async () => undefined,
    setLiveSearch: () => undefined,
    resolveNames: async () => ({}),
    getCatalog,
    onCatalog: (cb) => {
      push = cb;
      return () => {
        push = null;
      };
    },
    ...extra,
  });
  const root = shadows.rootOf(document.getElementById('ledger-bot-page')!);
  shadows.restore();
  const hint = () => root.querySelector('#ea-search .search-hint:last-child')?.textContent ?? '';
  return { page, root, getCatalog, push: (c: Catalog) => push!(c), hint };
}

describe('asking for the catalog', () => {
  it('sends nothing while hidden, once on open, and nothing on later opens once one was read', async () => {
    const { page, getCatalog, hint } = mount(catalog(1));
    vi.advanceTimersByTime(10_000);
    expect(getCatalog).not.toHaveBeenCalled();
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(getCatalog).toHaveBeenCalledTimes(1);
    expect(hint()).toContain("2 players from EA's player list.");
    // Open for a long while: no poll.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getCatalog).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      page.close();
      page.open();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(getCatalog).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next open while none has been read yet', async () => {
    const { page, getCatalog } = mount(null);
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    page.close();
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(getCatalog).toHaveBeenCalledTimes(2);
  });
});

describe('a catalog pushed by the web app', () => {
  it('redraws the search with it, without taking the box away from a name being typed', async () => {
    const { page, root, push, hint } = mount(catalog(1));
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    const input = root.querySelector<HTMLInputElement>('#nf-player')!;
    input.focus();
    input.value = 'Pla';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelectorAll('#nf-suggest button').length).toBe(2);
    push(catalog(2, 5));
    // Still the same box, still focused, suggestions still up: the new
    // catalog is drawn once the user is done with the box.
    expect(root.querySelector<HTMLInputElement>('#nf-player')).toBe(input);
    expect(root.activeElement).toBe(input);
    expect(hint()).toContain('2 players');
    input.blur();
    (root.querySelector('[data-dd="nation"]') as HTMLElement).click();
    expect(hint()).toContain('5 players');
  });

  it('is kept while the page is hidden and shown on the next open', async () => {
    const { page, push, hint, getCatalog } = mount(catalog(1));
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    page.close();
    push(catalog(2, 7));
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(hint()).toContain('7 players');
    expect(getCatalog).toHaveBeenCalledTimes(1);
  });

  it('is left alone when it is the one already shown', async () => {
    const { page, root, push } = mount(catalog(1));
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    const form = root.querySelector('#ea-search');
    push(catalog(1));
    expect(root.querySelector('#ea-search')).toBe(form);
  });
});

describe('timers', () => {
  it('leaves no timer behind after fifty opens and closes, and only the one tick while open', async () => {
    const { page } = mount(catalog(1));
    const idle = vi.getTimerCount();
    for (let i = 0; i < 50; i++) {
      page.open();
      await vi.advanceTimersByTimeAsync(5);
      page.close();
    }
    expect(vi.getTimerCount()).toBe(idle);
    page.open();
    await vi.advanceTimersByTimeAsync(5);
    expect(vi.getTimerCount()).toBe(idle + 1);
    page.close();
  });

  it('stops ticking while the tab is hidden and goes on when it shows again', async () => {
    const getTransferList = vi.fn(() => null);
    const { page } = mount(catalog(1), { getTransferList });
    page.open();
    await vi.advanceTimersByTimeAsync(10);
    getTransferList.mockClear();
    vi.advanceTimersByTime(3_000);
    expect(getTransferList).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    getTransferList.mockClear();
    vi.advanceTimersByTime(5_000);
    expect(getTransferList).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(2_000);
    expect(getTransferList.mock.calls.length).toBeGreaterThanOrEqual(2);
    page.close();
  });
});
