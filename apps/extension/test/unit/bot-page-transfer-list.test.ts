// The Nova AI page's Sold and Unsold counters and its Transfer list panel
// (`ui/bot-page.ts`): counted from the trade-pile responses EA's own page
// fetched (`lib/transfer-list.ts`, through `deps.getTransferList`), "—"
// until EA has loaded the whole list once, and kept up to date in place
// while the page is open.

import { DEFAULT_BOT_SETTINGS, type TradePileItem } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTransferListTracker,
  type TransferListSummary,
} from '../../src/lib/transfer-list.js';
import { createBotPage } from '../../src/ui/bot-page.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

const WAITING = 'Open your Transfer List in EA once and Nova AI will keep these up to date';

const card = (itemId: string, tradeState: TradePileItem['tradeState']): TradePileItem => ({
  itemId,
  tradeId: tradeState ? `9${itemId}` : null,
  resourceId: 20801,
  rating: 86,
  tradeState,
  currentBid: 0,
  buyNowPrice: tradeState ? 12_000 : 0,
  expires: null,
});

/** `n` cards in `state`, with ids from `from`. */
const cards = (from: number, n: number, state: TradePileItem['tradeState']): TradePileItem[] =>
  Array.from({ length: n }, (_, i) => card(String(from + i), state));

function mount(getTransferList?: () => TransferListSummary | null) {
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
    ...(getTransferList ? { getTransferList } : {}),
  });
  shadows.restore();
  const root = shadows.rootOf(document.getElementById('ledger-bot-page')!);
  const $ = (id: string) => root.getElementById(id)!;
  /** What the Sold counter, the Unsold counter and the panel show. */
  const shown = () => ({
    sold: $('d-sold').textContent,
    unsold: $('d-unsold').textContent,
    total: $('d-tl-n').textContent,
    bar: $('d-tl-bar').style.width,
    sub: $('d-tl-sub').textContent,
  });
  const waiting = () =>
    ['d-sold-row', 'd-unsold-row', 'd-tl'].every((id) => $(id).title === WAITING) &&
    ['d-sold', 'd-unsold', 'd-tl-big'].every((id) => $(id).classList.contains('na'));
  return { page, $, shown, waiting };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T12:00:00'));
  document.body.innerHTML = '';
  trustTestEvents();
});
afterEach(() => {
  vi.useRealTimers();
  untrustedEvents();
});

describe('the Sold / Unsold counters and the Transfer list panel', () => {
  it('show "—" and say how to fill them until EA has loaded the whole list', () => {
    const list = createTransferListTracker();
    const { page, shown, waiting } = mount(() => list.summary());
    page.open();
    expect(shown()).toEqual({ sold: '—', unsold: '—', total: '—', bar: '0%', sub: '' });
    expect(waiting()).toBe(true);

    // A relist response alone shows a few cards, not the list.
    list.update(cards(1, 3, 'active'), false);
    vi.advanceTimersByTime(1_000);
    expect(shown().total).toBe('—');
    expect(waiting()).toBe(true);
    page.close();
  });

  it('stay empty on a page given no transfer list', () => {
    const { page, shown, waiting } = mount();
    page.open();
    expect(shown()).toEqual({ sold: '—', unsold: '—', total: '—', bar: '0%', sub: '' });
    expect(waiting()).toBe(true);
    page.close();
  });

  it('count the list EA loaded, and follow it while the page is open', () => {
    const list = createTransferListTracker();
    // The trader opened their Transfer List in EA before opening Nova AI.
    list.update(
      [
        ...cards(1, 5, 'closed'),
        ...cards(10, 2, 'expired'),
        ...cards(20, 28, 'active'),
        ...cards(60, 2, null),
      ],
      true,
    );
    const { page, $, shown, waiting } = mount(() => list.summary());
    page.open();
    expect(shown()).toEqual({
      sold: '5',
      unsold: '2',
      total: '37',
      bar: '37%',
      sub: '28 listed · 5 sold · 2 unsold · 2 not listed',
    });
    expect(waiting()).toBe(false);
    for (const id of ['d-sold', 'd-unsold', 'd-tl-big'])
      expect($(id).classList.contains('na')).toBe(false);
    for (const id of ['d-sold-row', 'd-unsold-row', 'd-tl']) {
      expect($(id).title).not.toContain('not available');
      expect($(id).title).toContain('as EA last showed it');
    }

    // A card sells and EA's page reads it (no bot running to refresh the
    // dash): the figures follow within a second.
    list.update([card('20', 'closed')], false);
    vi.advanceTimersByTime(1_000);
    expect(shown()).toEqual({
      sold: '6',
      unsold: '2',
      total: '37',
      bar: '37%',
      sub: '27 listed · 6 sold · 2 unsold · 2 not listed',
    });
    page.close();
  });

  it('show every card on the list in the breakdown, so it adds up to the total', () => {
    // Production: "4 /100" over "0 listed · 0 not listed", the four being
    // sold cards waiting to be cleared.
    const list = createTransferListTracker();
    list.update([...cards(1, 3, 'closed'), ...cards(10, 1, 'expired')], true);
    const { page, shown } = mount(() => list.summary());
    page.open();
    expect(shown()).toMatchObject({ total: '4', sub: '0 listed · 3 sold · 1 unsold · 0 not listed' });
    page.close();
  });

  it('stop the bar at a full list', () => {
    const summary: TransferListSummary = {
      total: 120,
      sold: 0,
      unsold: 0,
      listed: 100,
      unlisted: 20,
      seenAt: Date.now(),
    };
    const { page, shown } = mount(() => summary);
    page.open();
    expect(shown()).toMatchObject({ total: '120', bar: '100%', sub: '100 listed · 20 not listed' });
    page.close();
  });

  it('write nothing while the figures stay the same', () => {
    const list = createTransferListTracker();
    list.update(cards(1, 4, 'active'), true);
    const { page, $, shown } = mount(() => list.summary());
    page.open();
    const observer = new MutationObserver(() => undefined);
    for (const id of ['d-sold-row', 'd-unsold-row', 'd-tl'])
      observer.observe($(id), {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    vi.advanceTimersByTime(5_000);
    expect(observer.takeRecords()).toHaveLength(0);

    list.update([card('1', 'expired')], false);
    vi.advanceTimersByTime(1_000);
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(shown()).toMatchObject({ unsold: '1', total: '4', sub: '3 listed · 1 unsold · 0 not listed' });
    observer.disconnect();
    page.close();
  });
});
