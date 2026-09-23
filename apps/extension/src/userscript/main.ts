/*
 * main.ts — the userscript build's entry (`node scripts/build.mjs
 * userscript`). One Tampermonkey script plays all three roles the extension
 * splits across its manifest:
 *
 *   MAIN world adapter  -> injected as a <script> element by `setup.ts`,
 *                          before EA's own code runs (`@run-at
 *                          document-start`)
 *   service worker      -> `background/index.ts`, running in this script
 *   ISOLATED content    -> `content/index.ts`, running in this script
 *
 * plus `launcher.ts` in place of the toolbar popup and options page. The
 * wiring between them is `browser-shim.ts`, aliased in for
 * `webextension-polyfill` at build time.
 *
 * Tampermonkey runs this script in its own isolated context, so the
 * adapter <-> content `window.postMessage` channel behaves exactly as it
 * does between the extension's MAIN and ISOLATED worlds.
 *
 * The imports below are side-effect imports and their ORDER is the boot
 * order: setup (transport + adapter), then background (registers the
 * message router), then content (sends its first message once the DOM is
 * ready). The build keeps side effects for this app's own modules only
 * (`scripts/build.mjs`, `USERSCRIPT_TREESHAKE`).
 */
import './setup.js';
import '../background/index.js';
import '../content/index.js';

import { installLauncher } from './launcher.js';

if (document.body) installLauncher();
else document.addEventListener('DOMContentLoaded', installLauncher, { once: true });
