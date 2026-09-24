import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '@testing-library/jest-dom/vitest';

// See packages/ui/test/setup.ts for why this is explicit: vitest.config.ts
// sets `globals: false`, so @testing-library/react's own auto-cleanup never
// registers.
afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver or pointer-capture APIs; Radix primitives
// (Checkbox, Select, Dialog) call them on mount/interaction.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

// jsdom doesn't implement scrolling; TanStack Router restores scroll on every
// navigation in the router tests.
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
}
