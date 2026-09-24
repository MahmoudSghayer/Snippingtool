/*
 * license.ts — bootstrap on startup, 10-min heartbeat via `chrome.alarms`
 * (never a `setInterval` — that timer lives in `background/license.ts`, this
 * file is just the HTTP + caching logic), and the 24h offline-grace cache
 * (docs/01-architecture.md, §3.2).
 *
 * The cache in `storage.local` is plain data anyone with devtools can edit,
 * so it is never trusted as stored. Every read goes through
 * `getCachedEntitlement()`, which verifies `entitlementBlob` and answers
 * features, the kill switch and expiry *only* from its signed claims (the
 * response fields cached beside it are ignored for those). A fresh network
 * response is used as-is: it came over HTTPS from the API just now.
 *
 * Blob format (`apps/api/src/lib/entitlements.ts`): a jose compact JWS,
 * `base64url(header).base64url(claims).base64url(signature)`, header
 * `{"alg":"EdDSA"}`, Ed25519 over the ASCII `header.claims`. Claims are
 * `entitlementBlobClaimsSchema` in `@sl/shared` (`snapshot`, `deviceId`,
 * `killSwitchActive`, `sub`, `iat`, `exp`). The public key is the API's
 * `ENTITLEMENT_PUBLIC_KEY`, baked in at build time as
 * `VITE_LICENSE_PUBLIC_KEY` (scripts/build.mjs), as SPKI PEM (`\n` escapes
 * fine) or a bare base64 32-byte raw key. With no key configured nothing
 * verifies, so a build without one simply has no offline grace.
 *
 * Only WebCrypto and `fetch` here (plus `storage.ts`), no Chrome-only API, so
 * the verification also works outside the extension.
 */

import {
  AUTOMATION_FEATURE_KEYS,
  entitlementBlobClaimsSchema,
  LISTABLE_FEATURE_KEYS,
  type BootstrapRequest,
  type BootstrapResponse,
  type EntitlementBlobClaims,
  type FeatureKey,
  type HeartbeatRequest,
  type HeartbeatResponse,
} from '@sl/shared';

import { apiJson } from './api.js';
import { recordServerTime } from './clock.js';
import { computeFingerprint, detectBrowser, detectOs } from './fingerprint.js';
import { retryFetch } from './http.js';
import { logger } from './logger.js';
import { getLocal, setLocal } from './storage.js';

const CACHE_KEY = 'sl.license.cache.v1';
/** docs/01-architecture.md §3.2, docs/05-subscriptions.md §4: 24h from the
 * moment the server signed the blob. */
export const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000;
/** How far in the future a `cachedAt` may be before the cache is refused. */
export const CACHE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const EXTENSION_VERSION = import.meta.env.VITE_EXTENSION_VERSION;
// The userscript carries the same M1–M3 surface as `ledger-auto` and reports
// itself as such, so it works against an API deployed before `userscript`
// joined `bootstrapRequestSchema`'s enum. The server only validates this
// field. Send `userscript` once every deployed API accepts it.
const BUILD_TARGET = import.meta.env.VITE_BUILD_TARGET === 'userscript' ? 'ledger-auto' : import.meta.env.VITE_BUILD_TARGET;
const PUBLIC_KEY_MATERIAL = import.meta.env.VITE_LICENSE_PUBLIC_KEY;

/** What sits in `storage.local`. Unverified: read features and the kill
 * switch through `getCachedEntitlement()`, never from here. */
export interface CachedEntitlement {
  bootstrap: BootstrapResponse;
  cachedAt: number;
}

/** A cache entry whose blob verified. `bootstrap.features`,
 * `bootstrap.killSwitchActive`, `userId` and `deviceId` are overwritten from
 * the signed claims. */
export interface VerifiedEntitlement extends CachedEntitlement {
  claims: EntitlementBlobClaims;
  /** ms since epoch, from the signed `iat` */
  issuedAt: number;
  /** `false` for a blob signed before the kill switch was a claim; then
   * `bootstrap.killSwitchActive` is `true` (fail closed) and callers should
   * ask the API (`resolveKillSwitch`). */
  killSwitchSigned: boolean;
}

function fromBase64(b64: string): Uint8Array {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let cachedPublicKey: Promise<CryptoKey | null> | undefined;

/** Accepts the API's `ENTITLEMENT_PUBLIC_KEY` as-is (SPKI PEM, with real
 * newlines or the `\n` escapes `.env` files use), bare base64 SPKI DER, or a
 * bare base64/base64url 32-byte raw Ed25519 key — the last is what the API's
 * extension download (apps/api/src/lib/extension-download.ts) writes into the
 * template build: the key's JWK `x`. `null` (never throws) when there is no
 * usable key. */
export async function importLicensePublicKey(material: string | undefined): Promise<CryptoKey | null> {
  if (!material) return null;
  // A downloadable-template build (scripts/build.mjs --template) whose key
  // placeholder the API never filled in. Matched on a fragment, never the
  // whole placeholder: the API replaces every occurrence of the full token
  // in the bundle, so spelling it out here would turn this check into a
  // comparison against the real key.
  if (/PLACEHOLDER/.test(material)) {
    logger.error(
      'this build still carries the download template\'s licence key placeholder (the API did not fill it in): the entitlement blob cannot be verified',
      'license',
    );
    return null;
  }
  try {
    const body = material
      .replace(/\\n/g, '\n')
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '');
    const der = fromBase64(body);
    const format = der.length === 32 ? 'raw' : 'spki';
    return await crypto.subtle.importKey(format, der as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  } catch (err) {
    logger.warn(`failed to import license public key: ${String(err)}`, 'license');
    return null;
  }
}

function importPublicKey(): Promise<CryptoKey | null> {
  return importLicensePublicKey(PUBLIC_KEY_MATERIAL);
}

function publicKey(): Promise<CryptoKey | null> {
  cachedPublicKey ??= importPublicKey();
  return cachedPublicKey;
}

function decodeJson(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(fromBase64(part)));
}

/** The blob's claims if its signature verifies against the built-in key,
 * the header is `EdDSA`, the signed `exp` is still ahead of `now` and the
 * signed `iat` is not more than 5 minutes after it; otherwise `null` (never
 * throws). */
export async function verifyEntitlementClaims(blob: string, now: number = Date.now()): Promise<EntitlementBlobClaims | null> {
  const parts = typeof blob === 'string' ? blob.split('.') : [];
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  const [headerB64, claimsB64, sigB64] = parts as [string, string, string];
  const key = await publicKey();
  if (!key) {
    logger.warn('no usable VITE_LICENSE_PUBLIC_KEY in this build: the entitlement blob cannot be verified', 'license');
    return null;
  }
  try {
    const header = decodeJson(headerB64) as { alg?: unknown } | null;
    if (header?.alg !== 'EdDSA') return null;
    const signingInput = new TextEncoder().encode(`${headerB64}.${claimsB64}`);
    const ok = await crypto.subtle.verify('Ed25519', key, fromBase64(sigB64) as BufferSource, signingInput);
    if (!ok) return null;
    const parsed = entitlementBlobClaimsSchema.safeParse(decodeJson(claimsB64));
    if (!parsed.success) return null;
    if (parsed.data.exp * 1000 <= now) return null;
    // Issued "in the future" means the local clock was wound back, which would
    // otherwise stretch the grace (measured from `iat`) indefinitely.
    if (parsed.data.iat * 1000 > now + CACHE_CLOCK_SKEW_MS) return null;
    return parsed.data;
  } catch (err) {
    logger.warn(`entitlement blob verification failed: ${String(err)}`, 'license');
    return null;
  }
}

/** `true` only for a blob that parses, verifies and has not expired. */
export async function verifyEntitlementBlob(blob: string, now: number = Date.now()): Promise<boolean> {
  return (await verifyEntitlementClaims(blob, now)) !== null;
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

/** The raw stored entry, unverified. For bookkeeping only (was anything
 * cached, when); entitlement decisions go through `getCachedEntitlement()`. */
export async function readUnverifiedCache(): Promise<CachedEntitlement | null> {
  return getLocal<CachedEntitlement | null>(CACHE_KEY, null);
}

/** The feature keys this build knows; anything else in the signed claims
 * is dropped. Per build target: `new Set(FEATURE_KEYS)` bundled every key,
 * `automation.autobuyer` included, into the listable `ledger` build's
 * background.js, which must never mention the autobuyer
 * (test/e2e/extension.spec.ts). `VITE_AUTOMATION` is a build-time constant,
 * so in `ledger` the automation list is folded away with the branch. */
const KNOWN_FEATURES: ReadonlySet<string> = new Set<string>(
  import.meta.env.VITE_AUTOMATION === '1' ? [...LISTABLE_FEATURE_KEYS, ...AUTOMATION_FEATURE_KEYS] : LISTABLE_FEATURE_KEYS,
);

/** The cached entitlement, verified on this read: `null` if there is none,
 * its `cachedAt` is more than 5 minutes ahead of `now`, or its blob fails
 * verification or has passed its signed expiry. Features, the kill switch
 * and the user/device come from the signed claims only. */
export async function getCachedEntitlement(now: number = Date.now()): Promise<VerifiedEntitlement | null> {
  const raw = await readUnverifiedCache();
  if (!raw || typeof raw.cachedAt !== 'number' || !raw.bootstrap) return null;
  if (raw.cachedAt > now + CACHE_CLOCK_SKEW_MS) {
    logger.warn('cached entitlement is stamped in the future — ignoring it', 'license');
    return null;
  }
  const claims = await verifyEntitlementClaims(raw.bootstrap.entitlementBlob, now);
  if (!claims) return null;
  const killSwitchSigned = claims.killSwitchActive !== undefined;
  return {
    cachedAt: raw.cachedAt,
    claims,
    issuedAt: claims.iat * 1000,
    killSwitchSigned,
    bootstrap: {
      ...raw.bootstrap,
      userId: claims.sub,
      deviceId: claims.deviceId,
      features: claims.snapshot.features.filter((f): f is FeatureKey => KNOWN_FEATURES.has(f)),
      killSwitchActive: claims.killSwitchActive ?? true,
    },
  };
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
  const sentAt = Date.now();
  const data = await apiJson<BootstrapResponse>('/api/v1/extension/bootstrap', { method: 'POST', body: JSON.stringify(body) });
  await recordServerTime(data.serverTime, sentAt, Date.now());
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
    const sentAt = Date.now();
    const data = await apiJson<HeartbeatResponse>('/api/v1/extension/heartbeat', { method: 'POST', body: JSON.stringify(body) });
    await recordServerTime(data.serverTime, sentAt, Date.now());
    const prior = await readUnverifiedCache();
    await cache({ ...data, userId: prior?.bootstrap.userId ?? '' });
    return data;
  } catch (err) {
    logger.warn(`heartbeat failed, extension falls back to the cached entitlement: ${String(err)}`, 'license');
    return null;
  }
}

export interface OfflineGraceResult {
  /** `true` only when the cache verifies (see `getCachedEntitlement`) and the
   * blob was signed within the last 24h — and was cached within the last
   * 24h, which a verified blob always was unless the clock moved back.
   * `false` means paid features are off (docs/01-architecture.md, §3.2);
   * `cached`'s signed kill switch still applies either way. */
  withinGrace: boolean;
  cached: VerifiedEntitlement | null;
}

/** Measured from the signed `iat`, not the editable `cachedAt`, so bumping
 * `cachedAt` cannot stretch the grace. */
export async function checkOfflineGrace(now: number = Date.now()): Promise<OfflineGraceResult> {
  const cached = await getCachedEntitlement(now);
  if (!cached) return { withinGrace: false, cached: null };
  const withinGrace = now - cached.issuedAt <= OFFLINE_GRACE_MS && now - cached.cachedAt <= OFFLINE_GRACE_MS;
  return { withinGrace, cached };
}

/** `GET /extension/kill-switch` (unauthenticated, one attempt, no backoff):
 * the live flag, or `null` if the API could not be reached or answered
 * nonsense. */
export async function fetchKillSwitch(): Promise<boolean | null> {
  try {
    const res = await retryFetch('/api/v1/extension/kill-switch', { method: 'GET' }, { retries: 0 });
    if (!res.ok) return null;
    const body = (await res.json()) as { active?: unknown };
    return typeof body.active === 'boolean' ? body.active : null;
  } catch {
    return null;
  }
}

/** The kill switch to honour for a cached entitlement: the signed claim if
 * the blob has one, otherwise the live flag from the API, otherwise `true`.
 * An unsigned "off" is never believed. */
export async function resolveKillSwitch(cached: VerifiedEntitlement | null): Promise<boolean> {
  if (cached?.killSwitchSigned) return cached.bootstrap.killSwitchActive;
  return (await fetchKillSwitch()) ?? true;
}
