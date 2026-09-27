// Helpers for testing the extension's in-page UI, which renders into closed
// shadow roots (so `host.shadowRoot` is null, to page scripts and to tests
// alike) and ignores events scripts make (ui/trusted-events.ts).

import { vi } from 'vitest';

import { resetTrustCheckForTests, setTrustCheckForTests } from '../../src/ui/trusted-events.js';

/** Records every shadow root created from now on, by host, however it was
 * opened. Call before mounting; `restore` puts `attachShadow` back. */
export function captureShadowRoots(): { rootOf: (host: Element) => ShadowRoot; restore: () => void } {
  const roots = new Map<Element, ShadowRoot>();
  const original = Element.prototype.attachShadow;
  const spy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = original.call(this, init);
    roots.set(this, root);
    return root;
  });
  return {
    rootOf: (host) => {
      const root = roots.get(host);
      if (!root) throw new Error('no shadow root was attached to that host');
      return root;
    },
    restore: () => spy.mockRestore(),
  };
}

/** jsdom marks every event a test dispatches untrusted. Treat them as a
 * user's, for tests of what the handlers do; `untrustedEvents()` goes back
 * to the browser's rule, for tests that scripts are ignored. */
export function trustTestEvents(): void {
  setTrustCheckForTests(() => true);
}

export function untrustedEvents(): void {
  resetTrustCheckForTests();
}
