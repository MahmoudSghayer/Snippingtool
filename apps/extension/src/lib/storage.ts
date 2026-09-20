/*
 * storage.ts — thin, typed wrappers over `browser.storage.local`/`.session`,
 * plus the WebCrypto AES-GCM helpers used to keep the refresh token
 * encrypted at rest (docs/01-architecture.md, "extension <-> apps/api" trust
 * boundary: the refresh token never sits in plaintext in storage.local).
 *
 * `storage.session` holds short-lived, in-memory-only data (the access
 * token, crash-recovery engine state) — cleared when the browser closes,
 * never written to disk. `storage.local` holds everything that should
 * survive a restart (the encrypted refresh token, cached settings/license,
 * the per-install AES key itself, logs).
 */
import browser from 'webextension-polyfill';

export async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const result = await browser.storage.local.get(key);
  return key in result ? (result[key] as T) : fallback;
}

export async function setLocal(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

export async function removeLocal(key: string | string[]): Promise<void> {
  await browser.storage.local.remove(key);
}

export async function getSession<T>(key: string, fallback: T): Promise<T> {
  const result = await browser.storage.session.get(key);
  return key in result ? (result[key] as T) : fallback;
}

export async function setSession(key: string, value: unknown): Promise<void> {
  await browser.storage.session.set({ [key]: value });
}

export async function removeSession(key: string | string[]): Promise<void> {
  await browser.storage.session.remove(key);
}

// ---- AES-GCM at rest, keyed per install ------------------------------------

const INSTALL_KEY_STORAGE_KEY = 'sl.installKey.jwk.v1';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getOrCreateInstallKey(): Promise<CryptoKey> {
  const storedJwk = await getLocal<JsonWebKey | null>(INSTALL_KEY_STORAGE_KEY, null);
  if (storedJwk) {
    return crypto.subtle.importKey('jwk', storedJwk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  await setLocal(INSTALL_KEY_STORAGE_KEY, jwk);
  return key;
}

/** Encrypts `plaintext` under this install's AES-GCM key, returning
 * `base64(iv).base64(ciphertext)`. Never call with anything that should
 * cross the network — this is at-rest protection for `storage.local`, not a
 * transport mechanism. */
export async function encryptString(plaintext: string): Promise<string> {
  const key = await getOrCreateInstallKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptString(payload: string): Promise<string> {
  const [ivB64, ctB64] = payload.split('.');
  if (!ivB64 || !ctB64) throw new Error('decryptString: malformed payload');
  const key = await getOrCreateInstallKey();
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(ctB64);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
