/*
 * launcher.ts — the userscript build's stand-in for the toolbar popup. A
 * small Nova Trade button on the EA page (bottom-right, clear of EA's
 * navigation) opens a drawer with
 * the account view, the very same `popup/app.ts` the extension uses. Also
 * reachable from Tampermonkey's menu. The tool itself opens from the
 * "Nova AI" item in EA's left navigation (`ui/ea-nav.ts`).
 *
 * The view gets its own shadow root: EA's styles cannot reach in, and the
 * popup's stylesheet — written for a whole page of its own — cannot leak
 * out. `:root` and `body` in it (and in `tokens.css`) are rewritten to the
 * shadow host and a wrapper element.
 *
 * Every shadow root here is closed and every handler ignores script-made
 * events (`onTrusted`), including the popup's own (`popup/app.ts`): on the
 * EA page, unlike in the extension, it shares a document with page scripts.
 */
import { mountPopup } from '../popup/app.js';
import popupCss from '../popup/style.css?raw';
import tokensCss from '../styles/tokens.css?raw';
import { NOVA_LOGO_SVG } from '../ui/brand.js';
import { onTrusted } from '../ui/trusted-events.js';

const LAUNCHER_CSS = `
  :host { all: initial; }
  .fab {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; overflow: hidden;
    background: #151d1a; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.45);
  }
  .fab svg { display: block; width: 100%; height: 100%; transform: scale(1.18); }
  .fab:hover { filter: brightness(1.12); }
  .fab:focus-visible { outline: 2px solid #fcfcfc; outline-offset: 2px; }
  .drawer {
    position: fixed; right: 16px; bottom: 70px; z-index: 2147483000;
    width: 360px; max-width: calc(100vw - 32px); max-height: calc(100vh - 90px);
    display: flex; flex-direction: column; overflow: hidden;
    background: #202c3d; border: 1px solid #deded826; border-radius: 10px;
    box-shadow: 0 16px 40px rgba(0,0,0,.55); font: 16px/1.4 UltimateTeam, sans-serif;
  }
  .drawer[hidden] { display: none; }
  .view { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
`;

/** Rewrites a stylesheet written for a whole page so it applies inside a
 * shadow root whose content sits in a `.sl-page` wrapper. */
function forShadow(css: string): string {
  return css.replace(/:root\b/g, ':host').replace(/(^|[\s,}])body\b/g, '$1.sl-page');
}

export function installLauncher(): void {
  const host = document.createElement('div');
  host.id = 'ledger-launcher';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = forShadow(tokensCss) + LAUNCHER_CSS;

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.type = 'button';
  fab.innerHTML = NOVA_LOGO_SVG;
  fab.title = 'Nova Trade account';
  fab.setAttribute('aria-label', 'Nova Trade account');
  fab.setAttribute('aria-expanded', 'false');

  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.hidden = true;
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'Nova Trade account');

  // A shadow-rooted view containing `<div class="sl-page"><div id="app">`,
  // so the popup module finds the `#app` element it was written for. The
  // popup's stylesheet sizes <body> to the toolbar popup's 360px; inside the
  // drawer the page just fills the available width.
  const view = document.createElement('div');
  view.className = 'view';
  const viewRoot = view.attachShadow({ mode: 'closed' });
  const viewStyle = document.createElement('style');
  viewStyle.textContent =
    forShadow(tokensCss) + forShadow(popupCss) + '.sl-page { width: auto; max-height: none; overflow: visible; }';
  const page = document.createElement('div');
  page.className = 'sl-page';
  const app = document.createElement('div');
  app.id = 'app';
  page.append(app);
  viewRoot.append(viewStyle, page);

  drawer.append(view);
  root.append(style, fab, drawer);
  document.body.appendChild(host);

  // Remounted on every open so the view reads fresh state, the way the
  // extension's popup does each time it reopens.
  function show(): void {
    drawer.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    mountPopup(app, { allowAutofill: false });
  }

  function hide(): void {
    drawer.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
  }

  onTrusted(fab, 'click', () => (drawer.hidden ? show() : hide()));
  onTrusted(drawer, 'keydown', (e) => {
    if (e.key === 'Escape') {
      hide();
      fab.focus();
    }
  });

  GM_registerMenuCommand('Open Nova Trade', () => show());
}
