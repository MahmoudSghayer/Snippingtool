import { defineConfig } from 'vitest/config';

// Integration tests run against the real local Postgres (TEST_DATABASE_URL)
// and real local Redis, per module in src/modules/<name>/__tests__. They
// share test-database state (truncated between files via resetDatabase), so
// files run one at a time (fileParallelism: false) — matching @sl/db's own
// vitest config for the same reason.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/*.test.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
