// The userscript build (src/userscript/setup.ts) authenticates its page
// channel exactly as the extension does: a per-page-load nonce handed to the
// injected adapter on <html> and used as the HMAC key. The one difference is
// where content's copy lives: in act-auth's module closure (the userscript is
// one bundle), never on a global object, which in Tampermonkey may be the
// page's own window. Its own file: the holder is module state.
//
// Tampermonkey does not guarantee the userscript runs before the page's own
// scripts, so the handoff fails closed unless the document is still loading
// and has no <script> yet other than the one running the userscript itself:
// nothing goes on <html>, and content gets no nonce.

import { afterEach, describe, expect, it } from 'vitest';

import {
  HANDOFF_ATTRIBUTE,
  handOffNonceWithinBundle,
  isSafeToHandOff,
  readHandedOffNonce,
  takeHandedOffNonce,
} from '../../src/lib/act-auth.js';

/** jsdom has finished parsing by the time a test runs; pretend it has not. */
function setReadyState(state: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => state });
}

afterEach(() => {
  delete (document as unknown as { readyState?: unknown }).readyState; // back to the prototype getter
  document.querySelectorAll('script').forEach((s) => s.remove());
  document.documentElement.removeAttribute(HANDOFF_ATTRIBUTE);
});

describe('userscript nonce handoff', () => {
  it('leaves the nonce for the adapter on <html> and for content only inside the bundle', () => {
    setReadyState('loading');
    const before = new Set(Object.getOwnPropertyNames(globalThis));
    const nonce = handOffNonceWithinBundle(document);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    // Nothing new on the global object for a page script to read.
    expect(Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k))).toEqual([]);
    expect((globalThis as Record<string, unknown>).__slAdapterNonce).toBeUndefined();

    // The injected adapter takes it off <html> (and removes it)...
    let adapterNonce: string | null = null;
    takeHandedOffNonce(document, (n) => (adapterNonce = n), { lateFallback: false });
    expect(adapterNonce).toBe(nonce);
    expect(document.documentElement.hasAttribute(HANDOFF_ATTRIBUTE)).toBe(false);

    // ...and content reads its copy once, by default, from the bundle.
    expect(readHandedOffNonce()).toBe(nonce);
    expect(readHandedOffNonce()).toBeNull();
  });

  it('fails closed when a page script element already exists', () => {
    setReadyState('loading');
    const pageScript = document.createElement('script');
    pageScript.textContent = '/* EA bootstrap */';
    document.head.appendChild(pageScript);
    expect(isSafeToHandOff(document)).toBe(false);

    expect(handOffNonceWithinBundle(document)).toBeNull();
    // Nothing on <html> for a page script's MutationObserver to see...
    expect(document.documentElement.hasAttribute(HANDOFF_ATTRIBUTE)).toBe(false);
    // ...no key for the adapter, and none for content: the channel is locked.
    let adapterNonce: string | null = null;
    takeHandedOffNonce(document, (n) => (adapterNonce = n), { lateFallback: false });
    expect(adapterNonce).toBeNull();
    expect(readHandedOffNonce()).toBeNull();
  });

  it("allows the script manager's own <script>, the one running the userscript", () => {
    setReadyState('loading');
    const own = document.createElement('script');
    document.documentElement.appendChild(own);
    Object.defineProperty(document, 'currentScript', { configurable: true, get: () => own });
    try {
      expect(isSafeToHandOff(document)).toBe(true);
      // ...but not when a page script sits next to it.
      document.head.appendChild(document.createElement('script'));
      expect(isSafeToHandOff(document)).toBe(false);
    } finally {
      delete (document as unknown as { currentScript?: unknown }).currentScript;
    }
  });

  it('fails closed when the document has finished loading (a late injection)', () => {
    for (const state of ['interactive', 'complete'] as const) {
      setReadyState(state);
      expect(isSafeToHandOff(document)).toBe(false);
      expect(handOffNonceWithinBundle(document)).toBeNull();
      expect(document.documentElement.hasAttribute(HANDOFF_ATTRIBUTE)).toBe(false);
      expect(readHandedOffNonce()).toBeNull();
    }
  });

  it('never falls back to a global a page script could have planted', () => {
    setReadyState('complete');
    (globalThis as Record<string, unknown>).__slAdapterNonce = 'a'.repeat(64);
    try {
      expect(handOffNonceWithinBundle(document)).toBeNull();
      expect(readHandedOffNonce()).toBeNull();
    } finally {
      delete (globalThis as Record<string, unknown>).__slAdapterNonce;
    }
  });

  it('the userscript adapter never takes a nonce that appears on <html> later', async () => {
    let adapterNonce: string | null = null;
    takeHandedOffNonce(document, (n) => (adapterNonce = n), { lateFallback: false });
    document.documentElement.setAttribute(HANDOFF_ATTRIBUTE, 'b'.repeat(64)); // a page script's
    await new Promise((r) => setTimeout(r, 0));
    expect(adapterNonce).toBeNull();
    expect(document.documentElement.getAttribute(HANDOFF_ATTRIBUTE)).toBe('b'.repeat(64));
  });
});
