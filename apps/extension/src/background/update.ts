/*
 * background/update.ts — auto-update. Chrome checks `update_url` (set in the
 * `ledger-auto` manifest only — see `scripts/generate-manifest.mjs`; the
 * `ledger` build has no `update_url` at all and is updated by the Chrome
 * Web Store instead) on its own schedule; this file just reacts to
 * `runtime.onUpdateAvailable` once Chrome has already found a newer
 * version.
 *
 * Known simplification (documented, not hidden — see docs/06-extension.md,
 * "Auto-update"): this applies the update immediately rather than first
 * confirming with the content script that no buy is in flight. A mid-buy
 * reload is possible in the current implementation; gating on engine state
 * is the natural next step once `apps/api`'s WS gateway (kill switch push)
 * lands and there is a live channel to ask the content script over.
 */
import browser from 'webextension-polyfill';

import { logger } from '../lib/logger.js';

export function installUpdateHandler(): void {
  browser.runtime.onUpdateAvailable.addListener((details) => {
    logger.info(`update available: ${details.version} — reloading`, 'update');
    browser.runtime.reload();
  });
}
