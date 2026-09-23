/*
 * background/license.ts — bootstrap on startup/login, and the 10-minute
 * heartbeat *driven by `chrome.alarms`* (never `setInterval` — rule 5: the
 * service worker owns no loops). `content/index.ts` asks for the current
 * entitlement via the `license.bootstrap` message; this file decides
 * whether that means "return the cache" or "hit the network", so the
 * content script never has to know the difference.
 *
 * The cache is only ever read verified (`license.getCachedEntitlement`):
 * features and the kill switch come from the signed blob, and a cache that
 * fails verification, is stamped in the future or has expired counts as no
 * cache. When the API is unreachable (network error, 5xx, 429) the last
 * verified entitlement carries on for the 24h offline grace; after that paid
 * features are off, and its kill switch is honoured throughout. An API that
 * answers and refuses (401/403/…) is not "offline" and gets no grace.
 */
import browser from 'webextension-polyfill';

import { ApiError } from '../lib/api.js';
import * as auth from '../lib/auth.js';
import * as license from '../lib/license.js';
import { logger } from '../lib/logger.js';
import { applyServerSettings } from '../lib/settings.js';
import { getLocal, setLocal } from '../lib/storage.js';

import { propagateKillSwitch } from './kill-switch.js';

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
  await propagateKillSwitch(data.killSwitchActive);
}

type BootstrapOutcome = { kind: 'ok'; data: BootstrapResponse } | { kind: 'offline' } | { kind: 'refused' };

/** "Offline" is what the grace exists for: the request never got an answer
 * (fetch threw) or the API is down/overloaded. Anything else is the API
 * speaking, and it said no. */
function isUnreachable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 429;
  return true;
}

async function bootstrapOutcome(): Promise<BootstrapOutcome> {
  try {
    const data = await license.bootstrap();
    await applyEntitlement(data);
    ensureHeartbeatAlarm();
    return { kind: 'ok', data };
  } catch (err) {
    logger.warn(`bootstrap failed: ${String(err)}`, 'license');
    return isUnreachable(err) ? { kind: 'offline' } : { kind: 'refused' };
  }
}

/** Always hits `/extension/bootstrap` — used right after login, and once at
 * extension startup if there is no recent cache yet. */
export async function runBootstrap(): Promise<BootstrapResponse | null> {
  if (!(await auth.isAuthenticated())) return null;
  const outcome = await bootstrapOutcome();
  return outcome.kind === 'ok' ? outcome.data : null;
}

/** The `license.bootstrap` message handler: returns the verified cache if
 * it's fresh enough, otherwise bootstraps for real, falling back to the
 * offline grace if the API can't be reached. This is what makes it cheap for
 * `content/index.ts` to call on every page load without hammering the API. */
export async function handleLicenseBootstrap(): Promise<BootstrapResponse | null> {
  if (!(await auth.isAuthenticated())) return null;
  const now = Date.now();
  // "Fresh" needs the signed issue time inside the grace too: `cachedAt` is
  // editable, so on its own it could keep a 25h-old blob "fresh" until the
  // blob's own expiry.
  const cached = await license.getCachedEntitlement(now);
  if (cached && now - cached.cachedAt < BOOTSTRAP_STALE_MS && now - cached.issuedAt <= license.OFFLINE_GRACE_MS) {
    return { ...cached.bootstrap, killSwitchActive: await license.resolveKillSwitch(cached) };
  }

  const outcome = await bootstrapOutcome();
  if (outcome.kind === 'ok') return outcome.data;
  if (outcome.kind === 'refused') return null;

  const grace = await license.checkOfflineGrace(now);
  if (!grace.cached) return null;
  const killSwitchActive = await license.resolveKillSwitch(grace.cached);
  await propagateKillSwitch(killSwitchActive);
  if (grace.withinGrace) return { ...grace.cached.bootstrap, killSwitchActive };
  logger.warn('offline grace expired — paid features are off until the API is reachable', 'license');
  return { ...grace.cached.bootstrap, features: [], killSwitchActive };
}

export async function handleLicenseHeartbeat(engineState: 'idle' | 'running' | 'paused' | 'halted'): Promise<HeartbeatResponse | null> {
  const deviceId = await getLocal<string | null>(DEVICE_ID_KEY, null);
  if (!deviceId) return null;
  const data = await license.heartbeat(deviceId, engineState);
  if (data) {
    await applyServerSettings(data.settings);
    // The heartbeat is how a kill switch flipped mid-session reaches an
    // installed extension (docs/06-extension.md §5); push it into every
    // open EA tab right away instead of waiting for their next reload.
    await propagateKillSwitch(data.killSwitchActive);
  }
  return data;
}

/** Fired from `background/index.ts`'s `alarms.onAlarm` listener. */
export async function onHeartbeatAlarm(): Promise<void> {
  await handleLicenseHeartbeat('idle'); // the alarm doesn't know the live engine state — content's own heartbeat calls (via 'engine.state') pass the real one
}

export async function checkOfflineGrace() {
  return license.checkOfflineGrace();
}
