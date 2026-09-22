/*
 * background/license.ts — bootstrap on startup/login, and the 10-minute
 * heartbeat *driven by `chrome.alarms`* (never `setInterval` — rule 5: the
 * service worker owns no loops). `content/index.ts` asks for the current
 * entitlement via the `license.bootstrap` message; this file decides
 * whether that means "return the cache" or "hit the network", so the
 * content script never has to know the difference.
 */
import browser from 'webextension-polyfill';

import * as auth from '../lib/auth.js';
import * as license from '../lib/license.js';
import { logger } from '../lib/logger.js';
import { applyServerSettings } from '../lib/settings.js';
import { getLocal, setLocal } from '../lib/storage.js';

import type { BootstrapResponse, HeartbeatResponse } from '@sl/shared';

const HEARTBEAT_ALARM = 'sl.license.heartbeat';
const HEARTBEAT_PERIOD_MINUTES = 10;
const BOOTSTRAP_STALE_MS = 10 * 60 * 1000;
const DEVICE_ID_KEY = 'sl.deviceId';

export function ensureHeartbeatAlarm(): void {
  browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
}

async function applyEntitlement(data: BootstrapResponse): Promise<void> {
  await setLocal(DEVICE_ID_KEY, data.deviceId);
  await applyServerSettings(data.settings);
}

/** Always hits `/extension/bootstrap` — used right after login, and once at
 * extension startup if there is no recent cache yet. */
export async function runBootstrap(): Promise<BootstrapResponse | null> {
  if (!(await auth.isAuthenticated())) return null;
  try {
    const data = await license.bootstrap();
    await applyEntitlement(data);
    ensureHeartbeatAlarm();
    return data;
  } catch (err) {
    logger.warn(`bootstrap failed: ${String(err)}`, 'license');
    return null;
  }
}

/** The `license.bootstrap` message handler: returns the cache if it's fresh
 * enough, otherwise bootstraps for real. This is what makes it cheap for
 * `content/index.ts` to call on every page load without hammering the API. */
export async function handleLicenseBootstrap(): Promise<BootstrapResponse | null> {
  if (!(await auth.isAuthenticated())) return null;
  const cached = await license.getCachedEntitlement();
  if (cached && Date.now() - cached.cachedAt < BOOTSTRAP_STALE_MS) {
    return cached.bootstrap;
  }
  return runBootstrap();
}

export async function handleLicenseHeartbeat(engineState: 'idle' | 'running' | 'paused' | 'halted'): Promise<HeartbeatResponse | null> {
  const deviceId = await getLocal<string | null>(DEVICE_ID_KEY, null);
  if (!deviceId) return null;
  const data = await license.heartbeat(deviceId, engineState);
  if (data) await applyServerSettings(data.settings);
  return data;
}

/** Fired from `background/index.ts`'s `alarms.onAlarm` listener. */
export async function onHeartbeatAlarm(): Promise<void> {
  await handleLicenseHeartbeat('idle'); // the alarm doesn't know the live engine state — content's own heartbeat calls (via 'engine.state') pass the real one
}

export async function checkOfflineGrace() {
  return license.checkOfflineGrace();
}
