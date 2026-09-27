/*
 * ea-nav.ts — adds a "Nova AI" item to the EA web app's navigation, under
 * Transfers, and keeps it there as EA re-renders.
 *
 * ASSUMED SHAPE, like `main/adapter.ts`: the web app's navigation is a
 * `.ut-tab-bar` element whose items are `.ut-tab-bar-item` buttons (Transfers
 * carries `icon-transfer`, the current screen's item carries `selected`), and
 * the top bar is `.ut-navigation-bar-view`. If that is not what the page has,
 * nothing is added and nothing breaks. `NAV_SELECTORS`, `TRANSFERS_SELECTOR`
 * and `HEADER_SELECTORS` are the lines to update when EA renames them.
 *
 * The item behaves like EA's own: it takes EA's item styling and `selected`
 * state (only one item looks selected at a time), clicking it toggles
 * `ui/bot-page.ts`, and clicking any of EA's items closes the page while EA
 * navigates as usual. The page is kept inside EA's content area — beside or
 * above the navigation, below the top bar — so it can never cover the
 * navigation and swallow its clicks.
 */
import { NOVA_MARK_SVG } from './brand.js';
import { onTrusted } from './trusted-events.js';

import type { PageBounds } from './bot-page.js';

const NAV_SELECTORS = ['.ut-tab-bar', 'nav.ut-tab-bar-view', '.ut-tab-bar-view'];
const ITEM_SELECTOR = '.ut-tab-bar-item';
const TRANSFERS_SELECTOR = '.ut-tab-bar-item.icon-transfer';
const ITEM_ID = 'sl-sniping-bot-nav';
/** EA's top bar (coin balance, notifications), which the bot page sits below. */
const HEADER_SELECTORS = ['.ut-navigation-bar-view', '.ut-app-header', 'header.ut-navigation-bar'];

export interface NavHooks {
  onToggle: () => void;
  onEaNavigate: () => void;
  /** Called with EA's content area whenever the navigation or top bar is
   * (re)found or the window resizes. */
  onBounds: (bounds: PageBounds) => void;
}

export interface NavItem {
  setActive(active: boolean): void;
  /** Whether EA's navigation was found and the item is in it. */
  isInstalled(): boolean;
}

function findNav(doc: Document): HTMLElement | null {
  for (const sel of NAV_SELECTORS) {
    const el = doc.querySelector<HTMLElement>(sel);
    if (el && el.querySelector(ITEM_SELECTOR)) return el;
  }
  return null;
}

type Rect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

/** EA's content area: the window minus the navigation (a sidebar on either
 * side, or a bar at the top or bottom, as EA lays it out for the window
 * size) and minus the top bar. */
export function contentBounds(nav: Rect | null, header: Rect | null, vw: number, vh: number): PageBounds {
  const b: PageBounds = { left: 0, top: 0, right: 0, bottom: 0 };
  // Only a bar pinned to the top of the window counts as the top bar.
  if (header && header.top <= 1 && header.height > 0 && header.height < 160) b.top = header.bottom;
  if (nav && nav.width > 0 && nav.height > 0) {
    if (nav.height >= nav.width) {
      if (nav.left + nav.width / 2 < vw / 2) b.left = Math.max(b.left, nav.right);
      else b.right = Math.max(b.right, vw - nav.left);
    } else if (nav.top + nav.height / 2 > vh / 2) {
      b.bottom = Math.max(b.bottom, vh - nav.top);
    } else {
      b.top = Math.max(b.top, nav.bottom);
    }
  }
  return b;
}

export function installNavItem(hooks: NavHooks, doc: Document = document): NavItem {
  let active = false;
  let navEl: HTMLElement | null = null;
  /** EA's item that was selected when the page opened: shown unselected
   * while the page is open, the way EA shows only the current screen. */
  let eaSelected: Element | null = null;

  function build(): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.id = ITEM_ID;
    btn.type = 'button';
    // EA's own class, so the item gets the navigation's sizing, spacing,
    // colours and selected state like the other items.
    btn.className = 'ut-tab-bar-item';
    btn.setAttribute('aria-label', 'Nova AI');
    btn.innerHTML = `<span style="display:block;width:24px;height:24px;margin:0 auto 4px">${NOVA_MARK_SVG}</span><span>Nova AI</span>`;
    onTrusted(btn, 'click', (e) => {
      e.stopPropagation();
      hooks.onToggle();
    });
    return btn;
  }

  function paint(btn: HTMLElement): void {
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-pressed', String(active));
    const nav = navEl;
    if (!nav) return;
    if (active) {
      const current = [...nav.querySelectorAll(`${ITEM_SELECTOR}.selected`)].find((el) => el !== btn);
      if (current) {
        eaSelected = current;
        current.classList.remove('selected');
      }
    } else if (eaSelected) {
      // Put EA's selection back, unless EA has since selected another item
      // itself (the user clicked it).
      const other = [...nav.querySelectorAll(`${ITEM_SELECTOR}.selected`)].some((el) => el !== btn);
      if (!other && eaSelected.isConnected) eaSelected.classList.add('selected');
      eaSelected = null;
    }
  }

  function measure(nav: HTMLElement): void {
    const header = HEADER_SELECTORS.map((sel) => doc.querySelector<HTMLElement>(sel)).find((el) => el != null);
    const view = doc.defaultView ?? window;
    hooks.onBounds(
      contentBounds(nav.getBoundingClientRect(), header?.getBoundingClientRect() ?? null, view.innerWidth, view.innerHeight),
    );
  }

  function ensure(): void {
    const nav = findNav(doc);
    if (!nav) return;
    if (nav !== navEl) {
      navEl = nav;
      // Capture phase, so this runs before EA's own handler and even if EA
      // stops propagation. It only closes the page; EA's click goes on.
      onTrusted(
        nav,
        'click',
        (e) => {
          const target = e.target as HTMLElement | null;
          if (target && !target.closest(`#${ITEM_ID}`) && target.closest(ITEM_SELECTOR)) hooks.onEaNavigate();
        },
        true,
      );
    }
    let btn = doc.getElementById(ITEM_ID);
    if (!btn || !nav.contains(btn)) {
      btn?.remove();
      btn = build();
      const transfers = nav.querySelector(TRANSFERS_SELECTOR);
      if (transfers?.parentElement) transfers.insertAdjacentElement('afterend', btn);
      else nav.appendChild(btn);
    }
    paint(btn);
    measure(nav);
  }

  // EA renders the navigation after login and re-renders it on some screens.
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensure();
    });
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  (doc.defaultView ?? window).addEventListener('resize', ensure);
  ensure();

  return {
    setActive(next) {
      active = next;
      const btn = doc.getElementById(ITEM_ID);
      if (btn) paint(btn);
      // Re-measure on open: EA may have changed its layout while closed.
      if (next && navEl) measure(navEl);
    },
    isInstalled: () => !!doc.getElementById(ITEM_ID),
  };
}
