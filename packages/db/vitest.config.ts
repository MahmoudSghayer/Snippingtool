import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Migrations + seed run against a shared Postgres test database, so tests
    // that mutate schema-wide state (migration application, partition
    // creation) must not run concurrently with each other.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
