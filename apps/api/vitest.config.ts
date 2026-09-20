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
    fileParallelism: false,
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
