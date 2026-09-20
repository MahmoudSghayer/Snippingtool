import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '@testing-library/jest-dom/vitest';

// See packages/ui/test/setup.ts for why this is explicit: vitest.config.ts
// sets `globals: false`, so @testing-library/react's own auto-cleanup never
// registers.
afterEach(() => {
  cleanup();
});
