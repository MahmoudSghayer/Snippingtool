/*
 * act-auth.ts — authenticates the act channel between content (ISOLATED
 * world) and main/adapter.ts (MAIN world), docs/09-security.md §13.
 *
 * The problem (defect C10): the channel is `window.postMessage`, which every
 * script on EA's page can both send on and listen to. Without this, any page
 * script could post an `act_request` and have the adapter call EA's buyNow
 * without ever passing through the governor, or post a fake `action_result`
 * and have content record a buy that never happened.
 *
 * The scheme:
 *   1. A tiny ISOLATED-world script (content/handoff.ts, `document_start`,
 *      listed before adapter.js in the manifest) generates a random 256-bit
 *      nonce per page load and puts it on <html> as an attribute. It keeps
 *      a copy in the ISOLATED world's own globals for content.js.
 *   2. adapter.ts (also `document_start`) reads the attribute, removes it,
 *      and keeps the nonce only in a closure. Both scripts run before any
 *      page script exists, so no page script can see the attribute.
 *   3. The nonce is then used as an HMAC-SHA256 key and never sent anywhere.
 *      Every `act_request` carries `mac = HMAC(nonce, canonical message)`,
 *      and every `action_result` the adapter sends back carries one too. A
 *      page script sees the MACs go past but cannot compute one for a
 *      message of its own. (Putting the nonce itself in each request would
 *      hand it to every page listener on the first buy.)
 *
 * What this is not: a security boundary. A MAIN-world script shares the
 * adapter's realm, so one that runs before it (another extension's
 * `document_start` MAIN-world script, say) could hook what it uses. The
 * primitives below are captured at module load to raise that bar for page
 * scripts that run later. See docs/threat-model.md §3.1 for the residual
 * risk.
 */

/** The <html> attribute the nonce crosses the world boundary on. Present
 * only between the two `document_start` scripts running. */
export const HANDOFF_ATTRIBUTE = 'data-sl-handoff';

/** Where content/handoff.ts leaves the nonce for content.js: a property on
 * the ISOLATED world's global object, which page scripts cannot reach. */
const HANDOFF_GLOBAL_KEY = '__slAdapterNonce';

/** Error strings the adapter's `action_result` uses for refusals. Content
 * records each as a failed attempt (engine/assist.ts, engine/autobuyer.ts). */
export const ACT_ERROR = {
  /** The listing's buy-now price is not the price content expected. */
  priceMismatch: 'price_mismatch',
  /** The adapter has not seen this tradeId listed (or it has expired). */
  listingUnknown: 'listing_unknown',
  /** The selected service-layer shape buys on the item entity a search
   * returned (main/shape-observable.ts), and the adapter's own act search
   * never returned this tradeId — it was only seen passively. */
  listingEntityUnknown: 'listing_entity_unknown',
  /** No nonce was handed off, so no act request can be authenticated. */
  unauthenticated: 'adapter_unauthenticated',
} as const;

const NONCE_PATTERN = /^[0-9a-f]{64}$/;

// ---- primitives captured at load --------------------------------------------
// In the MAIN world, this module runs at `document_start`, before any page
// script. Holding our own references means a page script that later
// replaces `JSON.stringify` or `SubtleCrypto.prototype.sign` does not change
// what the adapter computes.
const stringify = JSON.stringify;
const objectKeys = Object.keys;
const isArray = Array.isArray;
const arraySort = Array.prototype.sort;
const arrayMap = Array.prototype.map;
const arrayJoin = Array.prototype.join;
const regexpTest = RegExp.prototype.test;
const apply = Reflect.apply;
const TextEncoderCtor = globalThis.TextEncoder;
const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
const importKey = subtle?.importKey;
const hmacSign = subtle?.sign;
const hmacVerify = subtle?.verify;
const getRandomValues = globalThis.crypto?.getRandomValues;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i]! < 16 ? '0' : '') + bytes[i]!.toString(16);
  return out;
}

function unhex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && apply(regexpTest, NONCE_PATTERN, [value]) === true;
}

/** 32 random bytes, hex encoded. */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  apply(getRandomValues!, globalThis.crypto, [bytes]);
  return hex(bytes);
}

/** A key-order-independent JSON encoding, so both ends MAC the same bytes
 * whatever order an object's keys arrive in. Undefined values are dropped,
 * as JSON drops them. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return stringify(value) ?? 'null';
  if (isArray(value)) return '[' + apply(arrayJoin, apply(arrayMap, value, [(v: unknown) => canonicalize(v)]), [',']) + ']';
  const record = value as Record<string, unknown>;
  const keys = apply(arraySort, objectKeys(record), []) as string[];
  let out = '';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (record[key] === undefined) continue;
    out += (out ? ',' : '') + stringify(key) + ':' + canonicalize(record[key]);
  }
  return '{' + out + '}';
}

/** What a MAC covers: the message kind (so a request's MAC can never pass as
 * a result's, or vice versa) plus the whole `data` payload. */
export function canonicalActMessage(kind: 'act_request' | 'action_result', data: unknown): string {
  return canonicalize({ kind, data });
}

export interface ActSigner {
  /** Hex HMAC-SHA256 of `message` under the nonce. */
  sign(message: string): Promise<string>;
  /** Constant-time check of a hex MAC; false for anything malformed. */
  verify(message: string, mac: unknown): Promise<boolean>;
}

/** `null` when the nonce is malformed or WebCrypto is unavailable — callers
 * then treat the act channel as closed (fail closed, never open). */
export function createActSigner(nonce: string | null): ActSigner | null {
  if (!isHex64(nonce) || !subtle || !importKey || !hmacSign || !hmacVerify || !TextEncoderCtor) return null;
  const encoder = new TextEncoderCtor();
  const key: Promise<CryptoKey> = apply(importKey, subtle, [
    'raw',
    unhex(nonce),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  ]) as Promise<CryptoKey>;
  return {
    async sign(message) {
      const mac = (await apply(hmacSign, subtle, ['HMAC', await key, encoder.encode(message)])) as ArrayBuffer;
      return hex(new Uint8Array(mac));
    },
    async verify(message, mac) {
      if (!isHex64(mac)) return false;
      try {
        return (await apply(hmacVerify, subtle, ['HMAC', await key, unhex(mac), encoder.encode(message)])) === true;
      } catch {
        return false;
      }
    },
  };
}

// ---- the handoff ------------------------------------------------------------

/** ISOLATED world, `document_start` (content/handoff.ts): mint this page
 * load's nonce, leave it on <html> for the adapter, and keep a private copy
 * for content.js. Returns the nonce. */
export function handOffNonce(doc: Document = document, isolatedGlobal: object = globalThis): string {
  const nonce = generateNonce();
  Object.defineProperty(isolatedGlobal, HANDOFF_GLOBAL_KEY, { value: nonce, configurable: true, enumerable: false, writable: false });
  doc.documentElement?.setAttribute(HANDOFF_ATTRIBUTE, nonce);
  return nonce;
}

/** ISOLATED world, content.js: the nonce handoff.ts minted for this page
 * load, or `null` if it never ran. Read once — the copy is deleted so
 * nothing loaded later picks it up. */
export function readHandedOffNonce(isolatedGlobal: object = globalThis): string | null {
  const holder = isolatedGlobal as Record<string, unknown>;
  const nonce = holder[HANDOFF_GLOBAL_KEY];
  delete holder[HANDOFF_GLOBAL_KEY];
  return isHex64(nonce) ? nonce : null;
}

/** MAIN world, adapter.ts at `document_start`: take the nonce off <html>
 * and remove the attribute. The manifest lists handoff.js first, so the
 * attribute is normally already there. If the adapter ran first anyway, a
 * one-shot MutationObserver picks it up the moment handoff.js sets it —
 * but only until the parser starts adding the page's own nodes: no page
 * script can run before that happens (the parser runs a microtask
 * checkpoint before executing each script), so a value that shows up after
 * it could have come from a page script and is never taken. */
export function takeHandedOffNonce(doc: Document, onNonce: (nonce: string) => void): void {
  const root = doc.documentElement;
  if (!root) return;

  const take = (): boolean => {
    const value = root.getAttribute(HANDOFF_ATTRIBUTE);
    if (value == null) return false;
    root.removeAttribute(HANDOFF_ATTRIBUTE);
    if (isHex64(value)) onNonce(value);
    return true;
  };

  if (take()) return;
  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver((records) => {
    if (take() || records.some((r) => r.type === 'childList')) observer.disconnect();
  });
  observer.observe(root, { attributes: true, attributeFilter: [HANDOFF_ATTRIBUTE], childList: true });
}
