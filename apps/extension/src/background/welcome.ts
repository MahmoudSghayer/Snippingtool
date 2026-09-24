/*
 * welcome.ts — open the website's "My account" page the first time this
 * extension is installed.
 *
 * Why /account: it is the one customer page on the website. It shows
 * whether the pass is active, how to buy or extend one, and which devices
 * are signed in, which is everything a new user needs to check right after
 * loading the extension. (The old target, /bot, no longer exists; it now
 * redirects to /account anyway.)
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

/** The website page a fresh install opens. */
export const WELCOME_PATH = '/account';

export function installWelcomeHandler(): void {
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;
    if (!DASHBOARD_ORIGIN) {
      logger.warn('no VITE_DASHBOARD_ORIGIN configured — skipping welcome tab', 'background');
      return;
    }

    const url = `${DASHBOARD_ORIGIN.replace(/\/$/, '')}${WELCOME_PATH}`;
    // Never let a failed tab open take the service worker's install path with
    // it: the extension is fully functional without the welcome tab.
    void browser.tabs.create({ url }).catch((err) => {
      logger.warn(`could not open welcome tab: ${String(err)}`, 'background');
    });
  });
}
