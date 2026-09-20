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
    setupFiles: ['src/test/setup.ts'],
    // `fileParallelism: false` alone was not enough to fully serialize
    // execution — real, reproducible cross-file flakiness (a request in
    // file B intermittently failing with a stale/invalid-looking auth
    // response) still showed up under vitest even though the exact same
    // sequence run 25/25 times outside vitest (a plain tsx script driving
    // the same app.inject() calls) never failed once. `poolOptions.forks.
    // singleFork` pins every test file to one OS process with no worker
    // pool scheduling ambiguity, matching what every test file's own
    // sequential-by-design assumptions (one shared `app.redis` connection,
    // one Postgres pool, `resetDatabase()`-before-every-test) actually need.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    maxWorkers: 1,
    minWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        // @fastify/autoload dynamically `import()`s each src/modules/**
        // .ts file at runtime with a raw file:// URL — a call vite-node
        // can only intercept (and correctly remap `.js` specifiers back to
        // sibling `.ts` files, same as it does for our own statically
        // analysed imports) if autoload's own module is processed through
        // vite-node's SSR transform rather than left externalized/passed
        // straight to Node's native loader. Left externalized, module
        // autoloading fails under vitest (works fine under tsx, which
        // registers a process-wide loader hook autoload's dynamic import
        // benefits from) with a misleading ERR_MODULE_NOT_FOUND on the
        // *first* module's own internal imports.
        inline: ['@fastify/autoload'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
