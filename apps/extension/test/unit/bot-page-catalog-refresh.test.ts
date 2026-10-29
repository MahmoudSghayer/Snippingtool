// The Nova AI page no longer polls the catalog every 3s. It fetches it once
// on open and again only when content pushes refreshCatalog() after a save,
// and its once-a-second live tick pauses while the tab is hidden. These
// tests pin that the page sends no catalog.get while hidden, re-renders the
// Snipe Targets choices only when the catalog actually changed, and stops
// the live tick when the tab goes to the background.

import { DEFAULT_BOT_SETTINGS } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBotPage, type BotPage, type BotPageDeps } from '../../src/ui/bot-page.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

import type { Catalog } from '../../src/model/catalog.js';

/** Two microtask turns: enough for a `getCatalog().then(...)` chain. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function catalog(capturedAt: number): Catalog {
  return {
    players: [{ id: 1, name: 'Messi', rating: 93 }],
    levels: [],
    rarities: [],
    positions: [],
    playStyles: [],
    nations: [],
    leagues: [],
    clubs: {},
    capturedAt,
  };
}

function setTabHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

function mount(overrides: Partial<BotPageDeps>): { page: BotPage; root: ShadowRoot } {
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => null,
    getUnavailableReason: () => 'test',
    prepare: async () => undefined,
    getSettings: () => DEFAULT_BOT_SETTINGS,
    saveSettings: async () => undefined,
    setLiveSearch: () => undefined,
    resolveNames: async () => ({}),
    getCatalog: async () => null,
    ...overrides,
  });
  const host = document.getElementById('ledger-bot-page')!;
  const root = shadows.rootOf(host);
  shadows.restore();
  return { page, root };
}

describe('the Nova AI page catalog handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trustTestEvents();
  });
  afterEach(() => {
    vi.useRealTimers();
    untrustedEvents();
    setTabHidden(false);
    document.body.innerHTML = '';
  });

  it('sends no catalog.get while hidden, and fetches once on open', async () => {
    const getCatalog = vi.fn(async () => catalog(1));
    const { page } = mount({ getCatalog });

    page.refreshCatalog(); // page is created hidden
    await flush();
    expect(getCatalog).not.toHaveBeenCalled();

    page.open();
    await flush();
    expect(getCatalog).toHaveBeenCalledTimes(1);
  });

  it('re-renders the Snipe Targets choices only when the catalog changed', async () => {
    let current = catalog(1);
    const getCatalog = vi.fn(async () => current);
    const { page, root } = mount({ getCatalog });

    page.open();
    await flush();
    const targets = root.getElementById('targets')!;
    expect(targets.innerHTML).not.toBe(''); // rendered on open

    // A marker inside #targets survives a refresh that changes nothing...
    const marker = document.createElement('span');
    marker.id = 'keep-me';
    targets.appendChild(marker);
    page.refreshCatalog(); // same capturedAt
    await flush();
    expect(root.getElementById('keep-me')).not.toBeNull();

    // ...and is wiped when a genuinely newer catalog re-renders the panel.
    current = catalog(2);
    page.refreshCatalog();
    await flush();
    expect(root.getElementById('keep-me')).toBeNull();
  });

  it('pauses the once-a-second live tick while the tab is hidden', async () => {
    const getTransferList = vi.fn(() => null);
    const { page } = mount({ getCatalog: async () => catalog(1), getTransferList });

    page.open();
    await flush();
    getTransferList.mockClear();

    vi.advanceTimersByTime(1000);
    expect(getTransferList).toHaveBeenCalled(); // ticks while visible
    const whileVisible = getTransferList.mock.calls.length;

    setTabHidden(true);
    vi.advanceTimersByTime(3000);
    expect(getTransferList.mock.calls.length).toBe(whileVisible); // paused

    setTabHidden(false);
    vi.advanceTimersByTime(1000);
    expect(getTransferList.mock.calls.length).toBeGreaterThan(whileVisible); // resumed
  });
});
