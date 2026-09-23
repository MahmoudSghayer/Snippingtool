/*
 * ea-nav.ts — adds a "Sniping Bot" item to the EA web app's left navigation,
 * under Transfers, and keeps it there as EA re-renders.
 *
 * ASSUMED SHAPE, like `main/adapter.ts`: the web app's navigation is a
 * `.ut-tab-bar` element whose items are `.ut-tab-bar-item` buttons (Transfers
 * carries `icon-transfer`), and the top bar is `.ut-navigation-bar-view`.
 * If that is not what the page has, nothing is added and nothing breaks: the
 * page still opens from the in-page panel and the userscript's SL menu.
 * `NAV_SELECTORS`, `TRANSFERS_SELECTOR` and `HEADER_SELECTORS` are the lines
 * to update when EA renames them.
 *
 * The item only toggles `ui/bot-page.ts`; clicking any of EA's own items
 * closes the page again so EA's navigation keeps working as users expect.
 */

const NAV_SELECTORS = ['.ut-tab-bar', 'nav.ut-tab-bar-view', '.ut-tab-bar-view'];
const ITEM_SELECTOR = '.ut-tab-bar-item';
const TRANSFERS_SELECTOR = '.ut-tab-bar-item.icon-transfer';
const ITEM_ID = 'sl-sniping-bot-nav';
/** EA's top bar (coin balance, notifications), which the bot page sits below. */
const HEADER_SELECTORS = ['.ut-navigation-bar-view', '.ut-app-header', 'header.ut-navigation-bar'];

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style="display:block;margin:0 auto 4px">
  <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/>
  <circle cx="12" cy="12" r="2.5" fill="currentColor"/>
  <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

export interface NavHooks {
  onToggle: () => void;
  onEaNavigate: () => void;
  /** Called with the navigation's right edge and the bottom of EA's top bar
   * whenever they are (re)found, so the bot page sits beside and below them
   * like one of EA's own screens. 0 for anything not found. */
  onOffset: (leftPx: number, topPx: number) => void;
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

export function installNavItem(hooks: NavHooks, doc: Document = document): NavItem {
  let active = false;
  let navEl: HTMLElement | null = null;

  function build(): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.id = ITEM_ID;
    btn.type = 'button';
    // EA's own class, so the item gets the sidebar's sizing and spacing.
    btn.className = 'ut-tab-bar-item';
    btn.setAttribute('aria-label', 'Sniping Bot');
    btn.innerHTML = `${ICON}<span>Sniping Bot</span>`;
    btn.style.cssText = 'color:inherit;background:none;border:0;cursor:pointer;';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hooks.onToggle();
    });
    return btn;
  }

  function paint(btn: HTMLElement): void {
    btn.classList.toggle('selected', active);
    btn.style.color = active ? '#fff' : '';
    btn.setAttribute('aria-pressed', String(active));
  }

  function ensure(): void {
    const nav = findNav(doc);
    if (!nav) return;
    if (nav !== navEl) {
      navEl = nav;
      // Capture phase, so this runs even if EA stops propagation.
      nav.addEventListener(
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
    const rect = nav.getBoundingClientRect();
    const header = HEADER_SELECTORS.map((sel) => doc.querySelector<HTMLElement>(sel)).find((el) => el != null);
    const headerRect = header?.getBoundingClientRect();
    // Only a bar pinned to the top of the window counts; anything else is
    // not the header this is looking for.
    const top = headerRect && headerRect.top <= 1 && headerRect.height < 160 ? headerRect.bottom : 0;
    hooks.onOffset(rect.height > rect.width && rect.left < 80 ? rect.right : 0, top);
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
  window.addEventListener('resize', ensure);
  ensure();

  return {
    setActive(next) {
      active = next;
      const btn = doc.getElementById(ITEM_ID);
      if (btn) paint(btn);
    },
    isInstalled: () => !!doc.getElementById(ITEM_ID),
  };
}
