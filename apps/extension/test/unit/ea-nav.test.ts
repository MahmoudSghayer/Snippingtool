// The "Nova AI" item in EA's navigation (`ui/ea-nav.ts`) behaves like EA's
// own items: clicking an EA item closes the page and EA still gets the
// click; only one item looks selected; and the page is kept inside EA's
// content area, so it can never cover the navigation and swallow its clicks
// (the bug: a page at left 0 over a bottom tab bar, or a sidebar the old
// "tall bar within 80px of the left edge" check missed).

import { DEFAULT_BOT_SETTINGS } from '@sl/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBotPage, type PageBounds } from '../../src/ui/bot-page.js';
import { contentBounds, installNavItem } from '../../src/ui/ea-nav.js';

import { captureShadowRoots, trustTestEvents, untrustedEvents } from './ui-test-helpers.js';

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

function fakeEaNav() {
  document.body.innerHTML = `
    <header class="ut-navigation-bar-view"></header>
    <nav class="ut-tab-bar">
      <button class="ut-tab-bar-item icon-home">Home</button>
      <button class="ut-tab-bar-item icon-squad selected">Squads</button>
      <button class="ut-tab-bar-item icon-transfer">Transfers</button>
      <button class="ut-tab-bar-item icon-club">Club</button>
    </nav>`;
  const nav = document.querySelector<HTMLElement>('.ut-tab-bar')!;
  const item = (name: string) => [...nav.querySelectorAll<HTMLElement>('.ut-tab-bar-item')].find((b) => b.textContent === name)!;
  // EA's own navigation handler: moves `selected` to the clicked item.
  const eaClick = vi.fn((e: Event) => {
    const clicked = (e.target as HTMLElement).closest('.ut-tab-bar-item');
    if (!clicked || clicked.id) return;
    nav.querySelectorAll('.ut-tab-bar-item').forEach((b) => b.classList.toggle('selected', b === clicked));
  });
  nav.addEventListener('click', eaClick);
  return { nav, item, eaClick };
}

function mountBot() {
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
  return page;
}

beforeEach(() => {
  vi.useFakeTimers();
  trustTestEvents();
});
afterEach(() => {
  vi.useRealTimers();
  untrustedEvents();
});

describe('Nova AI nav item', () => {
  it('is added under Transfers with the Nova AI name', () => {
    const { nav } = fakeEaNav();
    installNavItem({ onToggle: vi.fn(), onEaNavigate: vi.fn(), onBounds: vi.fn() });
    const labels = [...nav.querySelectorAll('.ut-tab-bar-item')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Home', 'Squads', 'Transfers', 'Nova AI', 'Club']);
    const ours = document.getElementById('sl-sniping-bot-nav')!;
    expect(ours.getAttribute('aria-label')).toBe('Nova AI');
    expect(ours.querySelector('svg')).not.toBeNull();
  });

  it('opens the page; clicking Squads closes it and EA navigates on that first click', () => {
    const { item, eaClick } = fakeEaNav();
    const page = mountBot();
    const nav = installNavItem({
      onToggle: () => page.toggle(),
      onEaNavigate: () => page.close(),
      onBounds: (b) => page.setBounds(b),
    });
    page.onOpenChange((open) => nav.setActive(open));
    const ours = document.getElementById('sl-sniping-bot-nav')!;

    ours.click();
    expect(page.isOpen()).toBe(true);
    // Only one item looks selected: ours.
    expect([...document.querySelectorAll('.ut-tab-bar-item.selected')]).toEqual([ours]);

    item('Club').click();
    expect(page.isOpen()).toBe(false);
    expect(eaClick).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll('.ut-tab-bar-item.selected')]).toEqual([item('Club')]);
  });

  it('closing it any other way gives EA its selection back', () => {
    const { item } = fakeEaNav();
    const page = mountBot();
    const nav = installNavItem({ onToggle: () => page.toggle(), onEaNavigate: () => page.close(), onBounds: vi.fn() });
    page.onOpenChange((open) => nav.setActive(open));
    const ours = document.getElementById('sl-sniping-bot-nav')!;

    ours.click();
    ours.click(); // the item again
    expect(page.isOpen()).toBe(false);
    expect([...document.querySelectorAll('.ut-tab-bar-item.selected')]).toEqual([item('Squads')]);

    ours.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(page.isOpen()).toBe(false);
    expect([...document.querySelectorAll('.ut-tab-bar-item.selected')]).toEqual([item('Squads')]);
  });

  it('ignores clicks a page script makes', () => {
    fakeEaNav();
    const onToggle = vi.fn();
    installNavItem({ onToggle, onEaNavigate: vi.fn(), onBounds: vi.fn() });
    untrustedEvents();
    document.getElementById('sl-sniping-bot-nav')!.click();
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('contentBounds: the page stays in EA content area', () => {
  const vw = 1440;
  const vh = 900;
  const header = rect(0, 0, vw, 64);

  it('sits right of a left sidebar and below the top bar', () => {
    expect(contentBounds(rect(0, 64, 220, 836), header, vw, vh)).toEqual<PageBounds>({ left: 220, top: 64, right: 0, bottom: 0 });
  });

  it('sits right of a sidebar that does not start at the window edge', () => {
    // The old check (left < 80) gave 0 here, and the page covered the sidebar.
    expect(contentBounds(rect(96, 64, 200, 836), header, vw, vh).left).toBe(296);
  });

  it('sits above a bottom tab bar (EA narrow layout)', () => {
    // The old check gave left 0 and no bottom: the page covered the bar.
    expect(contentBounds(rect(0, 830, vw, 70), header, vw, vh)).toEqual<PageBounds>({ left: 0, top: 64, right: 0, bottom: 70 });
  });

  it('sits below a top tab bar, and left of a right sidebar', () => {
    expect(contentBounds(rect(0, 64, vw, 60), header, vw, vh).top).toBe(124);
    expect(contentBounds(rect(1240, 64, 200, 836), header, vw, vh).right).toBe(200);
  });

  it('ignores a header that is not pinned to the top', () => {
    expect(contentBounds(null, rect(0, 300, vw, 64), vw, vh).top).toBe(0);
  });
});
