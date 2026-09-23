/*
 * launcher.ts — the userscript build's stand-in for the toolbar popup and
 * the options page. A small button on the EA page (bottom-left, clear of the
 * in-page panel at bottom-right) opens a drawer with two tabs, Account and
 * Settings, which mount the very same `popup/app.ts` and `options/app.ts`
 * the extension uses. Also reachable from Tampermonkey's menu.
 *
 * Each view gets its own shadow root: EA's styles cannot reach in, and the
 * popup's and options page's stylesheets — both written for a whole page of
 * their own — cannot collide with each other. `:root` and `body` in those
 * stylesheets are rewritten to the shadow host and a wrapper element, the
 * same way `ui/panel.ts` adapts `tokens.css`.
 */
import { mountOptions } from '../options/app.js';
import optionsCss from '../options/style.css?raw';
import { mountPopup } from '../popup/app.js';
import popupCss from '../popup/style.css?raw';
import tokensCss from '../styles/tokens.css?raw';
import { onBotPageAvailable, openBotPage } from '../ui/bot-opener.js';

import { setOptionsPageOpener } from './browser-shim.js';

type Tab = 'account' | 'settings';

const LAUNCHER_CSS = `
  :host { all: initial; }
  .fab {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483000;
    width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--sl-line);
    background: var(--sl-surface); color: var(--sl-gold); cursor: pointer;
    font: 600 16px/1 system-ui, sans-serif; box-shadow: 0 6px 18px rgba(0,0,0,.45);
  }
  .fab:focus-visible { outline: 2px solid var(--sl-gold); outline-offset: 2px; }
  .drawer {
    position: fixed; left: 16px; bottom: 66px; z-index: 2147483000;
    width: 380px; max-width: calc(100vw - 32px); max-height: calc(100vh - 90px);
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--sl-ground); border: 1px solid var(--sl-line); border-radius: 10px;
    box-shadow: 0 16px 40px rgba(0,0,0,.55); font: 13px/1.4 system-ui, sans-serif;
  }
  .drawer[hidden] { display: none; }
  .tabs { display: flex; border-bottom: 1px solid var(--sl-line); }
  .tabs button {
    flex: 1; padding: 10px; border: 0; background: none; cursor: pointer;
    color: var(--sl-ink-2); font: 600 13px/1 system-ui, sans-serif;
  }
  .tabs button[aria-selected='true'] { color: var(--sl-ink); box-shadow: inset 0 -2px 0 var(--sl-gold); }
  .tabs button:focus-visible { outline: 2px solid var(--sl-gold); outline-offset: -2px; }
  .tabs .bot { flex: none; color: #1d9bf0; }
  .tabs .bot[hidden] { display: none; }
  .view { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .view[hidden] { display: none; }
`;

/** Rewrites a stylesheet written for a whole page so it applies inside a
 * shadow root whose content sits in a `.sl-page` wrapper. */
function forShadow(css: string): string {
  return css.replace(/:root\b/g, ':host').replace(/(^|[\s,}])body\b/g, '$1.sl-page');
}

/** A shadow-rooted view containing `<div class="sl-page"><div id="app">`,
 * so the mounted module finds the `#app` element it was written for. */
function createView(pageCss: string, extraCss: string): { host: HTMLElement; app: HTMLElement } {
  const host = document.createElement('div');
  host.className = 'view';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = forShadow(tokensCss) + forShadow(pageCss) + extraCss;
  const page = document.createElement('div');
  page.className = 'sl-page';
  const app = document.createElement('div');
  app.id = 'app';
  page.append(app);
  root.append(style, page);
  return { host, app };
}

export function installLauncher(): void {
  const host = document.createElement('div');
  host.id = 'ledger-launcher';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = forShadow(tokensCss) + LAUNCHER_CSS;

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.type = 'button';
  fab.textContent = 'SL';
  fab.title = "Sniper's Ledger";
  fab.setAttribute('aria-label', "Open Sniper's Ledger");
  fab.setAttribute('aria-expanded', 'false');

  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.hidden = true;
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', "Sniper's Ledger");

  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabs.setAttribute('role', 'tablist');
  const tabButtons: Record<Tab, HTMLButtonElement> = {
    account: document.createElement('button'),
    settings: document.createElement('button'),
  };
  tabButtons.account.textContent = 'Account';
  tabButtons.settings.textContent = 'Settings';

  // The popup's stylesheet sizes <body> to the toolbar popup's 360px; inside
  // the drawer the page should just fill the available width.
  const account = createView(
    popupCss,
    '.sl-page { width: auto; max-height: none; overflow: visible; }',
  );
  const settings = createView(
    optionsCss,
    '#app { max-width: none; margin: 0; padding: 16px 14px 40px; }',
  );
  const views: Record<Tab, { host: HTMLElement; app: HTMLElement }> = { account, settings };

  for (const tab of ['account', 'settings'] as const) {
    const btn = tabButtons[tab];
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => show(tab));
    tabs.append(btn);
  }
  // Opens the full Sniping Bot page (automation builds, once the content
  // script has created it).
  const botButton = document.createElement('button');
  botButton.type = 'button';
  botButton.className = 'bot';
  botButton.textContent = 'Sniping Bot ▸';
  botButton.hidden = true;
  botButton.addEventListener('click', () => {
    if (openBotPage()) hide();
  });
  tabs.append(botButton);
  onBotPageAvailable((available) => (botButton.hidden = !available));

  drawer.append(tabs, account.host, settings.host);
  root.append(style, fab, drawer);
  document.body.appendChild(host);

  // Remounted on every open so each view reads fresh state, the way the
  // extension's popup does each time it reopens.
  function show(tab: Tab): void {
    drawer.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    for (const t of ['account', 'settings'] as const) {
      tabButtons[t].setAttribute('aria-selected', String(t === tab));
      views[t].host.hidden = t !== tab;
    }
    if (tab === 'account') mountPopup(account.app, { allowAutofill: false });
    else mountOptions(settings.app);
  }

  function hide(): void {
    drawer.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
  }

  fab.addEventListener('click', () => (drawer.hidden ? show('account') : hide()));
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hide();
      fab.focus();
    }
  });

  setOptionsPageOpener(() => show('settings'));
  GM_registerMenuCommand("Open Sniper's Ledger", () => show('account'));
  GM_registerMenuCommand("Sniper's Ledger settings", () => show('settings'));
  GM_registerMenuCommand('Open Sniping Bot', () => void openBotPage());
}
