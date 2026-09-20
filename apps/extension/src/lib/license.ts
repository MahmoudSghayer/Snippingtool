/*
 * license.ts — bootstrap on startup, 10-min heartbeat via `chrome.alarms`
 * (never a `setInterval` — that timer lives in `background/license.ts`, this
 * file is just the HTTP + caching logic), and the 24h offline-grace cache
 * (docs/01-architecture.md, §3.2).
 *
 * The entitlement blob is treated as opaque and Ed25519-verified, never
 * decoded for anything beyond "was this issued and is it still within its
 * own cache window" — the trusted fields for actual decisions are the
 * bootstrap/heartbeat response's own typed fields (`subscription`,
 * `license`, `features`, `settings`, `killSwitchActive`), not a
 * client-side re-derivation from the blob.
 *
 * ASSUMED blob format (apps/api is built concurrently by another agent —
 * this is the contract this file expects, documented so it's easy to align
 * once that lands): `base64url(payloadJson).base64url(ed25519Signature)`,
 * where `payloadJson` is at minimum `{ userId, deviceId, issuedAt }`. If no
 * `VITE_LICENSE_PUBLIC_KEY` is configured (e.g. local dev against a backend
 * that doesn't sign yet), verification is skipped with a loud warning
 * instead of silently trusting an unverifiable blob in production.
 */

import { apiJson } from './api.js';
import { computeFingerprint, detectBrowser, detectOs } from './fingerprint.js';
import { logger } from './logger.js';
import { getLocal, setLocal } from './storage.js';

import type { BootstrapRequest, BootstrapResponse, HeartbeatRequest, HeartbeatResponse } from '@sl/shared';

const CACHE_KEY = 'sl.license.cache.v1';
const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000;

const EXTENSION_VERSION = import.meta.env.VITE_EXTENSION_VERSION;
const BUILD_TARGET = import.meta.env.VITE_BUILD_TARGET;
const PUBLIC_KEY_B64 = import.meta.env.VITE_LICENSE_PUBLIC_KEY;

export interface CachedEntitlement {
  bootstrap: BootstrapResponse;
  cachedAt: number;
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let cachedPublicKey: CryptoKey | null | undefined;

async function importPublicKey(): Promise<CryptoKey | null> {
  if (cachedPublicKey !== undefined) return cachedPublicKey;
  if (!PUBLIC_KEY_B64) {
    cachedPublicKey = null;
    return null;
  }
  try {
    cachedPublicKey = await crypto.subtle.importKey('raw', fromBase64(PUBLIC_KEY_B64) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  } catch (err) {
    logger.warn(`failed to import license public key: ${String(err)}`, 'license');
    cachedPublicKey = null;
  }
  return cachedPublicKey;
}

/** `true` only for a blob that parses and verifies; `false` (never throws)
 * for anything else, including "no public key configured" — callers decide
 * what an unverifiable blob means for them (bootstrap/heartbeat trust the
 * HTTPS response directly regardless; the offline-grace check below refuses
 * to extend trust past a network round trip without one). */
export async function verifyEntitlementBlob(blob: string): Promise<boolean> {
  const [payloadB64, sigB64] = blob.split('.');
  if (!payloadB64 || !sigB64) return false;
  const key = await importPublicKey();
  if (!key) {
    logger.warn('no VITE_LICENSE_PUBLIC_KEY configured — entitlement blob cannot be verified', 'license');
    return false;
  }
  try {
    return await crypto.subtle.verify('Ed25519', key, fromBase64(sigB64) as BufferSource, fromBase64(payloadB64) as BufferSource);
  } catch (err) {
    logger.warn(`entitlement blob verification threw: ${String(err)}`, 'license');
    return false;
  }
}

async function buildDeviceFingerprint() {
  return {
    fingerprint: await computeFingerprint(),
    browser: detectBrowser(),
    os: detectOs(),
    extensionVersion: EXTENSION_VERSION,
  };
}

async function cache(data: BootstrapResponse | (HeartbeatResponse & { userId: string })): Promise<void> {
  const entry: CachedEntitlement = { bootstrap: data as BootstrapResponse, cachedAt: Date.now() };
  await setLocal(CACHE_KEY, entry);
}

export async function getCachedEntitlement(): Promise<CachedEntitlement | null> {
  return getLocal<CachedEntitlement | null>(CACHE_KEY, null);
}

/** `POST /extension/bootstrap` — called once on startup and again right
 * after login. Never mutates the governor/settings directly; the caller
 * (`background/license.ts`) applies the response. */
export async function bootstrap(): Promise<BootstrapResponse> {
  const body: BootstrapRequest = {
    device: await buildDeviceFingerprint(),
    extensionVersion: EXTENSION_VERSION,
    buildTarget: BUILD_TARGET,
  };
  const data = await apiJson<BootstrapResponse>('/api/v1/extension/bootstrap', { method: 'POST', body: JSON.stringify(body) });
  await cache(data);
  return data;
}

/** `POST /extension/heartbeat` — every 10 minutes via `chrome.alarms`
 * (background/license.ts owns the alarm; this is just the call + cache
 * refresh). Returns `null` on failure rather than throwing, so the caller's
 * fallback is always "read the cache, check the offline grace window". */
export async function heartbeat(deviceId: string, engineState: HeartbeatRequest['engineState']): Promise<HeartbeatResponse | null> {
  try {
    const body: HeartbeatRequest = { deviceId, extensionVersion: EXTENSION_VERSION, engineState };
    const data = await apiJson<HeartbeatResponse>('/api/v1/extension/heartbeat', { method: 'POST', body: JSON.stringify(body) });
    const prior = await getCachedEntitlement();
    await cache({ ...data, userId: prior?.bootstrap.userId ?? '' });
    return data;
  } catch (err) {
    logger.warn(`heartbeat failed, extension falls back to the cached entitlement: ${String(err)}`, 'license');
    return null;
  }
}

export interface OfflineGraceResult {
  /** `true` only when there is a cached entitlement, its blob verifies, and
   * it was cached within the last 24h — everything else (no cache, unverifiable
   * blob, or grace expired) is `false`, which callers treat as "downgrade to
   * M1 read-only" (docs/01-architecture.md, §3.2). */
  withinGrace: boolean;
  cached: CachedEntitlement | null;
}

export async function checkOfflineGrace(now: number = Date.now()): Promise<OfflineGraceResult> {
  const cached = await getCachedEntitlement();
  if (!cached) return { withinGrace: false, cached: null };
  const verified = await verifyEntitlementBlob(cached.bootstrap.entitlementBlob);
  if (!verified) return { withinGrace: false, cached };
  return { withinGrace: now - cached.cachedAt <= OFFLINE_GRACE_MS, cached };
}
