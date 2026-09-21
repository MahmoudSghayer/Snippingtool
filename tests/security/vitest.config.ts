import { defineConfig } from 'vitest/config';

// Cross-cutting security tests, run against the real built @sl/api app
// (buildApp() from '@sl/api/app') and the real local Postgres/Redis test
// instances — same infra @sl/api's own integration tests use, never mocks.
// See README.md for env vars and how to run this package standalone.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/setup.ts'],
    globalSetup: ['src/global-setup.ts'],
    // Every test file builds its own app instance and truncates/flushes its
    // own state in beforeEach — matching @sl/api's own test convention —
    // but several suites here (rate-limit, lockout) depend on exact
    // request counts within a shared Redis window, so files still run
    // strictly sequentially, same reasoning as apps/api/vitest.config.ts.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    maxWorkers: 1,
    minWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
