// The Nova AI page's Bid mode (`ui/bot-page.ts`): Snipe or Bid above Start
// (Snipe by default, saved on its own, locked while the bot runs), the
// Bidding settings while Bid is picked, what the max price means in Bid
// mode, auto-sell covering both modes, the open bids while it runs, and Bid
// mode's log lines with the card's name in them.

import { DEFAULT_BOT_MODE_SETTINGS, DEFAULT_BOT_SETTINGS, type BotModeSettings, type BotSettings } from '@sl/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Sniper, type SniperLogEntry, type SniperSearchResult } from '../../src/engine/sniper.js';
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

function makeSniper(): Sniper {
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
    DEFAULT_BOT_SETTINGS,
  );
}

function mount(initialMode: BotModeSettings = DEFAULT_BOT_MODE_SETTINGS, initial: BotSettings = DEFAULT_BOT_SETTINGS) {
  let mode = initialMode;
  const modeSaves: BotModeSettings[] = [];
  const sniper = makeSniper();
  const shadows = captureShadowRoots();
  const page = createBotPage({
    getSniper: () => sniper,
    getUnavailableReason: () => null,
    prepare: async () => undefined,
    getSettings: () => initial,
    saveSettings: async () => undefined,
    getModeSettings: () => mode,
    saveModeSettings: async (next) => {
      mode = next;
      modeSaves.push(next);
    },
    setLiveSearch: () => undefined,
    resolveNames: async (ids) => Object.fromEntries(ids.map((id) => [id, 'Kika Nazareth'])),
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
  const checked = () => root.querySelector('.mode[aria-checked="true"]')?.getAttribute('data-mode');
  const refresh = async () => {
    page.refresh();
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    page.refresh();
    vi.advanceTimersByTime(100);
  };
  return { root, $, click, type, checked, sniper, page, modeSaves, mode: () => mode, refresh };
}

it('offers Snipe and Bid above Start, Snipe by default, and saves the choice on its own', () => {
  const { root, click, checked, modeSaves, sniper } = mount();
  const modes = [...root.querySelectorAll<HTMLElement>('.modes .mode')].map((b) => [b.firstChild!.textContent, b.querySelector('small')!.textContent]);
  expect(modes).toEqual([
    ['Snipe', 'Buy Now at or under your max price'],
    ['Bid', 'Bid in the last minutes, up to your max price'],
  ]);
  expect(checked()).toBe('snipe');
  // Beside Start, like the rest of the run bar.
  expect(root.getElementById('modes')!.closest('.runbar')).toBe(root.getElementById('start')!.closest('.runbar'));

  click('[data-mode="bid"]');
  expect(checked()).toBe('bid');
  expect(modeSaves.at(-1)).toEqual({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'bid' });
  expect(sniper.getModeSettings().mode).toBe('bid');
});

it('shows the Bidding settings and what the max price means only while Bid is picked', () => {
  const { $, click, root } = mount();
  expect($('bd-window')).toBeNull();
  expect($('bid-hint')).toBeNull();

  click('[data-mode="bid"]');
  expect($('bd-window')!.value).toBe('5');
  expect($('bd-active')!.value).toBe('10');
  expect($('bd-bph')!.value).toBe('60');
  expect($('bid-hint')!.textContent).toBe(
    "In Bid mode, Max is the most Nova AI bids for this player. When a card's Buy Now price is at or under it, Nova AI buys it with Buy Now instead.",
  );
  expect(root.querySelector('#knobs')!.textContent).toContain('Bid in the last');

  click('[data-mode="snipe"]');
  expect($('bd-window')).toBeNull();
  expect($('bid-hint')).toBeNull();
});

it('saves the Bidding settings, and refuses one outside its bounds', () => {
  const { $, click, type, modeSaves } = mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'bid' });
  type('bd-active', '12');
  expect(modeSaves.at(-1)!.bidding).toEqual({ windowMinutes: 5, maxActiveBids: 12, maxBidsPerHour: 60 });
  click('[data-step="bd-window"][data-dir="1"]');
  expect(modeSaves.at(-1)!.bidding.windowMinutes).toBe(6);

  const saves = modeSaves.length;
  type('bd-active', '80');
  expect(modeSaves).toHaveLength(saves);
  expect($('bd-active')!.getAttribute('aria-invalid')).toBe('true');
});

it('says auto-sell covers both modes', () => {
  const { $ } = mount();
  expect($('as-modes')!.textContent).toBe(
    'Applies in both modes: to cards bought with Buy Now and to auctions won in Bid mode. With auto-sell off, cards won in Bid mode are moved to your transfer list without a listing.',
  );
});

it('asks for a max price before Start in Bid mode: it is the max bid', () => {
  const { $, click, type, sniper } = mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'bid' });
  type('nf-player', '100');
  expect($('run-status')!.textContent).toBe('Set a Max price: in Bid mode it is the most Nova AI bids for a player');
  const start = vi.spyOn(sniper, 'start');
  click('#start');
  expect(start).not.toHaveBeenCalled();

  type('nf-maxBuy', '12500');
  expect($('run-status')!.textContent).toBe('Bids on Player #100, max 12,500');
});

it('locks the choice while the bot runs, and shows its open bids', async () => {
  const { root, sniper, refresh, $ } = mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'bid' });
  vi.spyOn(sniper, 'isRunning').mockReturnValue(true);
  vi.spyOn(sniper, 'getBidStatus').mockReturnValue({ active: 4, max: 10, committed: 48_000 });
  vi.spyOn(sniper, 'getStats').mockReturnValue({ ...sniper.getStats(), startedAt: Date.now() });
  await refresh();
  expect($('run-status')!.textContent).toMatch(/^Running for 0:00 · Active bids: 4\/10/);
  for (const b of root.querySelectorAll<HTMLButtonElement>('.modes .mode')) expect(b.disabled).toBe(true);
});

it('names a paused bid limit in the header chip', async () => {
  const { sniper, refresh, $ } = mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'bid' });
  vi.spyOn(sniper, 'isRunning').mockReturnValue(true);
  vi.spyOn(sniper, 'state', 'get').mockReturnValue({
    phase: 'waiting',
    phaseEndsAt: null,
    stopReason: null,
    stopDetail: null,
    notice: 'Bidding paused: bid limit (60 of 60 bids in the last hour) — resumes about 02:14',
  });
  await refresh();
  expect($('phase')!.textContent).toBe('Bidding paused');
});

it("writes Bid mode's log lines with the card's name in the sentence", async () => {
  const { sniper, refresh, $ } = mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'bid' });
  const at = Date.now();
  const card = { resourceId: 100, assetId: 100, rating: 85 };
  const log: SniperLogEntry[] = [
    { id: 6, at, kind: 'listed', ...card, price: 17_000, message: 'your fixed price' },
    { id: 5, at, kind: 'won', ...card, price: 12_500, sellPrice: 17_000, profit: 3_650, message: 'Won {card} for 12,500' },
    { id: 4, at, kind: 'dropped', ...card, price: 12_500, message: 'Max bid reached on {card} — dropping it', detail: 'the next bid would be 12,750, your max is 12,500' },
    { id: 3, at, kind: 'bid', ...card, price: 12_500, message: 'Outbid on {card} at 12,250 — re-bidding 12,500' },
    { id: 2, at, kind: 'bid', ...card, price: 12_250, message: 'Bid 12,250 on {card} (current bid 12,000, 3 min left)' },
    { id: 1, at, kind: 'moved', ...card, message: 'Moved {card} to your transfer list' },
  ];
  vi.spyOn(sniper, 'getLog').mockReturnValue(log);
  await refresh();
  const text = $('log')!.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain('Bid 12,250 on 85 Kika Nazareth (current bid 12,000, 3 min left)');
  expect(text).toContain('Outbid on 85 Kika Nazareth at 12,250 — re-bidding 12,500');
  expect(text).toContain('Max bid reached on 85 Kika Nazareth — dropping it');
  expect(text).toContain('the next bid would be 12,750, your max is 12,500');
  expect(text).toContain('Won 85 Kika Nazareth for 12,500');
  expect(text).toContain('85 Kika Nazareth listed for 17,000');
  expect(text).toContain('Moved 85 Kika Nazareth to your transfer list');
  expect(text).not.toContain('{card}');
});

it('shows the bid a search result would take', async () => {
  const { sniper, refresh, $ } = mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'bid' });
  const result: SniperSearchResult = {
    id: 1,
    at: Date.now(),
    filterName: 'Target',
    matches: [
      { tradeId: 'a', resourceId: 100, assetId: 100, rating: 85, buyNow: 20_000, expiresAt: Date.now() + 180_000, bid: 12_250, currentBid: 12_000 },
      { tradeId: 'b', resourceId: 100, assetId: 100, rating: 85, buyNow: 20_000, expiresAt: Date.now() + 200_000, bid: 800, currentBid: 0 },
    ],
    listings: 3,
    cheapest: 15_000,
  };
  vi.spyOn(sniper, 'getSearchResults').mockReturnValue([result]);
  await refresh();
  const text = $('results')!.textContent!.replace(/\s+/g, ' ');
  // The auction's own price beside the bid: the current bid, or its start.
  expect(text).toContain('bid 12,250 (now 12,000)');
  expect(text).toContain('bid 800 (start)');
});

it('shows a lost lead in the search results as a re-bid, or as over the max', async () => {
  const { sniper, refresh, $ } = mount({ ...DEFAULT_BOT_MODE_SETTINGS, mode: 'bid' });
  const lost = (id: number, outbid: 'rebid' | 'over_max', bid: number): SniperSearchResult => ({
    id,
    at: Date.now(),
    filterName: 'Outbid',
    matches: [{ tradeId: `a${id}`, resourceId: 100, assetId: 100, rating: 85, buyNow: 20_000, expiresAt: Date.now() + 90_000, bid, outbid }],
    listings: 1,
    cheapest: null,
  });
  vi.spyOn(sniper, 'getSearchResults').mockReturnValue([lost(2, 'over_max', 12_750), lost(1, 'rebid', 12_250)]);
  await refresh();
  const text = $('results')!.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain('Outbid: you lost the lead, re-bidding');
  expect(text).toContain('re-bid 12,250');
  expect(text).toContain('Outbid: the next bid is over your max, dropping it');
  expect(text).toContain('next bid 12,750, over your max');
});
