// The userscript build (src/userscript/setup.ts) authenticates its page
// channel exactly as the extension does: a per-page-load nonce handed to the
// injected adapter on <html> and used as the HMAC key. The one difference is
// where content's copy lives: in act-auth's module closure (the userscript is
// one bundle), never on a global object, which in Tampermonkey may be the
// page's own window. Its own file: the holder is module state.

import { describe, expect, it } from 'vitest';

import { HANDOFF_ATTRIBUTE, handOffNonceWithinBundle, readHandedOffNonce, takeHandedOffNonce } from '../../src/lib/act-auth.js';

describe('userscript nonce handoff', () => {
  it('leaves the nonce for the adapter on <html> and for content only inside the bundle', () => {
    const before = new Set(Object.getOwnPropertyNames(globalThis));
    const nonce = handOffNonceWithinBundle(document);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    // Nothing new on the global object for a page script to read.
    expect(Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k))).toEqual([]);
    expect((globalThis as Record<string, unknown>).__slAdapterNonce).toBeUndefined();

    // The injected adapter takes it off <html> (and removes it)...
    let adapterNonce: string | null = null;
    takeHandedOffNonce(document, (n) => (adapterNonce = n));
    expect(adapterNonce).toBe(nonce);
    expect(document.documentElement.hasAttribute(HANDOFF_ATTRIBUTE)).toBe(false);

    // ...and content reads its copy once, by default, from the bundle.
    expect(readHandedOffNonce()).toBe(nonce);
    expect(readHandedOffNonce()).toBeNull();
  });
});
