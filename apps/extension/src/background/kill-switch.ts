/*
 * background/kill-switch.ts — pushes the server kill switch into EA tabs
 * that are already open, and answers the content script's cheap pull.
 *
 * Project rule 3 (docs/01-architecture.md): the server kill switch is
 * unconditional. Until this file existed the content script only read
 * `killSwitchActive` from its own bootstrap reply at page load, so an
 * engine already running in an open tab kept running until the next
 * reload — the 10-minute heartbeat refreshed background's cached
 * entitlement (`lib/license.ts`) and nobody told the tab. Now every
 * bootstrap/heartbeat result flows through `propagateKillSwitch()`:
 *   - push: `tabs.query({ url: EA_WEB_APP_MATCHES })` +
 *     `tabs.sendMessage(tabId, { type: 'engine.killSwitch', ... })` to each
 *     EA tab (no new manifest permission — a `url`-filtered query only
 *     needs the EA host permissions the manifest already declares);
 *   - pull: `handleKillSwitchGet()` serves the cached flag from
 *     `storage.local` (no network) so the content script's engine tick can
 *     self-correct within one tick if a push was missed (service worker
 *     asleep, tab mid-navigation).
 * The last pushed value is kept in `storage.session` so a restarted service
 * worker still knows whether the tabs were already told.
 */
import browser from 'webextension-polyfill';

import { EA_WEB_APP_MATCHES } from '../../ea-origins.mjs';
import * as license from '../lib/license.js';
import { logger } from '../lib/logger.js';
import { getSession, setSession } from '../lib/storage.js';

import type { ExtContentKillSwitchMessage } from '@sl/shared';

const LAST_PUSHED_KEY = 'sl.killswitch.pushed.v1';
export const DEFAULT_REASON = 'server kill switch active';

interface LastPushed {
  active: boolean;
  at: number;
}

/** Tells every open EA tab about the current kill-switch state. Always
 * broadcasts while the switch is active (a re-confirmation is cheap and
 * closes the "tab opened between two heartbeats" gap belt-and-braces with
 * the pull), and broadcasts a deactivation exactly once. Returns how many
 * tabs acknowledged, for tests and logs. */
export async function propagateKillSwitch(active: boolean, reason?: string): Promise<{ notified: number }> {
  const previous = await getSession<LastPushed | null>(LAST_PUSHED_KEY, null);
  await setSession(LAST_PUSHED_KEY, { active, at: Date.now() } satisfies LastPushed);
  if (!active && previous?.active === false) return { notified: 0 };
  if (!active && previous === null) return { notified: 0 };

  const message: ExtContentKillSwitchMessage = {
    type: 'engine.killSwitch',
    payload: active ? { active, reason: reason ?? DEFAULT_REASON } : { active },
  };

  let tabs: Array<{ id?: number }>;
  try {
    tabs = await browser.tabs.query({ url: [...EA_WEB_APP_MATCHES] });
  } catch (err) {
    logger.warn(`kill switch: could not enumerate EA tabs: ${String(err)}`, 'kill-switch');
    return { notified: 0 };
  }

  let notified = 0;
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await browser.tabs.sendMessage(tab.id, message);
        notified++;
      } catch {
        // A matching tab with no content script yet (still loading, or a
        // tab we cannot reach) — it will read the flag from its own
        // bootstrap, or from the pull, once it is up.
      }
    }),
  );
  if (active) logger.warn(`kill switch active — ${notified} EA tab(s) told to halt`, 'kill-switch');
  return { notified };
}

/** `license.killSwitchGet`: the cached entitlement's flag, no network. */
export async function handleKillSwitchGet(): Promise<{ active: boolean; reason?: string }> {
  const cached = await license.getCachedEntitlement();
  const active = cached?.bootstrap.killSwitchActive ?? false;
  return active ? { active, reason: DEFAULT_REASON } : { active };
}
