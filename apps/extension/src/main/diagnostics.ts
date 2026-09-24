/*
 * diagnostics.ts — the MAIN-world half of the day-one diagnostics kit
 * (docs/06-extension.md §4). Two small pieces the adapter uses to answer an
 * authenticated `diagnostics` act request:
 *
 *   - `describeKeys`: what an object looks like — key names and value
 *     types, never values. Used on `window.services` (to see what EA's
 *     service layer is actually called) and on the last market response
 *     (to see its envelope). Reads property *descriptors*, so it never
 *     calls a getter or any other page code, and it walks the prototype
 *     chain because a service's methods live there, not on the instance.
 *   - `createAdapterLog`: a small ring buffer of the adapter's own log
 *     lines, scrubbed as they are written (lib/redact.ts).
 *
 * Zod-free and chrome-free, like the rest of `src/main/`, so the userscript
 * build can bundle it with the adapter.
 */
import { isSecretLookingKey, scrubText } from '../lib/redact.js';

import type { DiagnosticsKeyTree } from '@sl/shared';

const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyNames = Object.getOwnPropertyNames;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const isArray = Array.isArray;
const ObjectProto = Object.prototype;
const FunctionProto = Function.prototype;

/** Keys listed per object; past it, one `'#more'` entry says how many. */
const MAX_KEYS_PER_OBJECT = 80;
/** Nodes in the whole tree, so a wide object three levels deep stays a
 * report, not a megabyte. */
const MAX_NODES = 1500;
/** Longest key name reported; `adapterDiagnosticsSchema` rejects longer,
 * and a rejected report is one content never sees. */
const MAX_KEY_LENGTH = 120;

/** An array's length, read through its own property descriptor: no page
 * code runs (a Proxy's trap aside, which the caller guards). */
function arrayLength(value: unknown[]): string {
  const descriptor = getOwnPropertyDescriptor(value, 'length');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'number' ? String(descriptor.value) : '?';
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (isArray(value)) {
    try {
      return `array(${arrayLength(value)})`;
    } catch {
      return 'array(?)';
    }
  }
  return typeof value;
}

/** Own keys plus inherited ones up to (not including) Object.prototype /
 * Function.prototype, in order, each once. */
function allKeys(value: object): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let current: object | null = value;
  for (let level = 0; current && current !== ObjectProto && current !== FunctionProto && level < 10; level++) {
    for (const key of getOwnPropertyNames(current)) {
      if (key === 'constructor' && current !== value) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    current = getPrototypeOf(current) as object | null;
  }
  return keys;
}

/** The descriptor for `key` wherever it sits on `value`'s prototype chain. */
function findDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  let current: object | null = value;
  for (let level = 0; current && level < 10; level++) {
    const descriptor = getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
    current = getPrototypeOf(current) as object | null;
  }
  return undefined;
}

/**
 * `value` described to `depth` levels of keys: a leaf is a type name
 * (`'function'`, `'number'`, `'array(21)'`, `'object'` where the depth ran
 * out, `'getter'` for an accessor that was not called, `'object (seen)'`
 * for a cycle). An array is described by its length and its first element.
 * Property names that look like data (an email, a long id) are replaced.
 */
export function describeKeys(value: unknown, depth: number): DiagnosticsKeyTree {
  let nodes = 0;
  const seen = new Set<object>();

  function walk(current: unknown, remaining: number): DiagnosticsKeyTree {
    nodes++;
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return typeName(current);
    if (typeof current === 'function' || remaining <= 0 || nodes >= MAX_NODES) return typeName(current);
    if (seen.has(current)) return 'object (seen)';
    seen.add(current);

    if (isArray(current)) {
      const out: Record<string, DiagnosticsKeyTree> = { '#array': typeName(current) };
      // `[0]` through its descriptor too: an index can be a getter.
      let first: PropertyDescriptor | undefined;
      try {
        first = getOwnPropertyDescriptor(current, '0');
      } catch {
        first = undefined;
      }
      if (first) out['[0]'] = 'value' in first ? walk(first.value, remaining - 1) : 'getter';
      return out;
    }

    const out: Record<string, DiagnosticsKeyTree> = {};
    let keys: string[];
    try {
      keys = allKeys(current);
    } catch {
      // A Proxy whose ownKeys/getPrototypeOf trap throws.
      return 'object (unreadable)';
    }
    let listed = 0;
    let redacted = 0;
    for (const key of keys) {
      if (listed >= MAX_KEYS_PER_OBJECT || nodes >= MAX_NODES) break;
      // `__proto__` would set the prototype of the report object itself.
      if (key === '__proto__') continue;
      if (isSecretLookingKey(key)) {
        redacted++;
        continue;
      }
      listed++;
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = findDescriptor(current, key);
      } catch {
        descriptor = undefined;
      }
      if (!descriptor) continue;
      out[key.slice(0, MAX_KEY_LENGTH)] = 'value' in descriptor ? walk(descriptor.value, remaining - 1) : 'getter';
    }
    if (redacted > 0) out['#redactedKeys'] = String(redacted);
    if (keys.length > listed + redacted) out['#more'] = String(keys.length - listed - redacted);
    return out;
  }

  return walk(value, depth);
}

export interface AdapterLog {
  add(message: string): void;
  lines(): string[];
}

/** A ring buffer of the adapter's last `max` log lines, each timestamped
 * and scrubbed on the way in. */
export function createAdapterLog(max: number, now: () => number = Date.now): AdapterLog {
  const buffer: string[] = [];
  return {
    add(message) {
      let stamp: string;
      try {
        stamp = new Date(now()).toISOString();
      } catch {
        stamp = '?';
      }
      buffer.push(`${stamp} ${scrubText(message).slice(0, 900)}`);
      while (buffer.length > max) buffer.shift();
    },
    lines: () => buffer.slice(),
  };
}
