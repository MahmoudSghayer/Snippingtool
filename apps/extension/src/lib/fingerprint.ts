/*
 * fingerprint.ts — a stable hash of non-PII browser signals, used only as
 * `deviceFingerprintSchema.fingerprint` (packages/shared/src/schemas/auth.ts)
 * for device registration and license heartbeat. Never anything
 * EA-specific, never anything that identifies the *person* beyond "this is
 * probably the same browser install as last time" — see docs/06-extension.md,
 * "What it sends".
 *
 * A random per-install salt (generated once, stored in `storage.local`) is
 * mixed in so the fingerprint is stable across the extension's own
 * restarts but is not simply a hash of otherwise-public UA/locale strings
 * two different installs on the same machine/browser build would share.
 */
import { getLocal, setLocal } from './storage.js';

const SALT_KEY = 'sl.fingerprint.salt.v1';

async function getOrCreateSalt(): Promise<string> {
  const existing = await getLocal<string | null>(SALT_KEY, null);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await setLocal(SALT_KEY, salt);
  return salt;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeFingerprint(): Promise<string> {
  const salt = await getOrCreateSalt();
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  const parts = [
    nav.userAgent ?? '',
    nav.language ?? '',
    String(nav.hardwareConcurrency ?? ''),
    String((nav as { deviceMemory?: number }).deviceMemory ?? ''),
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
    salt,
  ];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  return toHex(new Uint8Array(digest));
}

export function detectBrowser(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Firefox\//.test(ua)) return 'firefox';
  return 'unknown';
}

export function detectOs(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac OS X/.test(ua)) return 'macos';
  if (/Linux/.test(ua)) return 'linux';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  return 'unknown';
}
