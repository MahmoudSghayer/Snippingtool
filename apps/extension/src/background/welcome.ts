/*
 * welcome.ts — open the companion site's Bot page the first time this
 * extension is installed.
 *
 * Why the Bot page specifically: the extension can record and rank on its
 * own, but it has nothing to search until at least one saved filter exists,
 * and a filter is built on the website (`/bot`), not in the popup. Landing
 * the user there on install is the shortest path from "loaded the extension"
 * to "the bot has something to do".
 *
 * Only `reason === 'install'` opens a tab. An update or a browser restart
 * fires `onInstalled` too (`'update'` / `'chrome_update'`), and stealing a
 * tab from someone who merely restarted Chrome is exactly the behaviour that
 * gets an extension uninstalled. Loading unpacked reports `'install'` every
 * time, which is what makes this visible during development.
 *
 * `tabs.create` needs no `tabs` permission — that permission gates *reading*
 * tab URLs/titles, not opening one — so this adds no new manifest surface.
 */
import browser from 'webextension-polyfill';

import { logger } from '../lib/logger.js';

const DASHBOARD_ORIGIN = import.meta.env.VITE_DASHBOARD_ORIGIN;

export function installWelcomeHandler(): void {
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;
    if (!DASHBOARD_ORIGIN) {
      logger.warn('no VITE_DASHBOARD_ORIGIN configured — skipping welcome tab', 'background');
      return;
    }

    const url = `${DASHBOARD_ORIGIN.replace(/\/$/, '')}/bot`;
    // Never let a failed tab open take the service worker's install path with
    // it: the extension is fully functional without the welcome tab.
    void browser.tabs.create({ url }).catch((err) => {
      logger.warn(`could not open welcome tab: ${String(err)}`, 'background');
    });
  });
}
