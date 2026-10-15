// The Nova AI page covers EA's top bar, so its header shows the trader's
// coins and FC Points, read from that bar (`ui/ea-wallet.ts`) and kept up
// to date while the page is open.

import { DEFAULT_BOT_SETTINGS } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBotPage } from '../../src/ui/bot-page.js';
import { parseBalance, readWallet } from '../../src/ui/ea-wallet.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

describe('parseBalance', () => {
  it.each([
    ['1,234,567', 1_234_567],
    ['1.234.567', 1_234_567],
    ['1\u00a0234\u00a0567', 1_234_567],
    [' 950 ', 950],
    ['0', 0],
  ])('reads %j as %d', (text, value) => {
    expect(parseBalance(text)).toBe(value);
  });

  it.each(['', '1.2M', '—', 'coins', '12345678901234'])('reads %j as unknown', (text) => {
    expect(parseBalance(text)).toBeNull();
  });
});

function eaTopBar(coins: string, points: string): void {
  document.body.innerHTML = `
    <header class="ut-navigation-bar-view">
      <div class="view-navbar-currency">
        <div class="view-navbar-currency-coins">${coins}</div>
        <div class="view-navbar-currency-points">${points}</div>
      </div>
    </header>`;
}

describe('the Nova AI header balance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trustTestEvents();
  });
  afterEach(() => {
    vi.useRealTimers();
    untrustedEvents();
  });

  function mount() {
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
    });
    shadows.restore();
    const root = shadows.rootOf(document.getElementById('ledger-bot-page')!);
    const shown = (id: string) => {
      const el = root.getElementById(id)!;
      return el.hidden ? null : el.querySelector('.amt')!.textContent;
    };
    return { page, root, shown };
  }

  it("shows EA's coins and FC Points, and follows them while open", () => {
    eaTopBar('1,250,000', '120');
    const { page, shown } = mount();
    page.open();
    expect(shown('w-coins')).toBe('1,250,000');
    expect(shown('w-points')).toBe('120');

    // A buy: EA updates its own bar, the header follows within a second.
    document.querySelector('.view-navbar-currency-coins')!.textContent = '1,198,000';
    vi.advanceTimersByTime(1_000);
    expect(shown('w-coins')).toBe('1,198,000');
    page.close();
  });

  it('stays out of the way when EA shows no balance', () => {
    document.body.innerHTML = '';
    expect(readWallet()).toEqual({ coins: null, points: null });
    const { page, root } = mount();
    page.open();
    expect(root.getElementById('wallet')!.hidden).toBe(true);
    page.close();
  });
});
