import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '@testing-library/jest-dom/vitest';

// `globals: false` (vitest.config.ts) means @testing-library/react's own
// auto-cleanup (which only registers when it finds a global `afterEach`)
// never fires, so it's wired explicitly here instead — otherwise DOM from
// one test leaks into the next within the same file.
afterEach(() => {
  cleanup();
});
