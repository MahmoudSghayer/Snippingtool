// @ts-check
import { base } from '../../packages/config/eslint-preset.js';

/**
 * `apps/extension` owns its own flat ESLint config (rather than relying on
 * the repo-root `eslint.config.js`) because the root config still ignores
 * `apps/extension/**` — that ignore predates the TypeScript migration
 * (PHASE 6) and is milestone-1 JS scaffolding this package does not own
 * (root files are out of scope for this package, see apps/extension/README.md
 * and docs/06-extension.md). ESLint's flat-config resolution finds the
 * nearest `eslint.config.js` by walking up from the linted files, so running
 * `pnpm --filter @sl/extension lint` (cwd = this directory) picks up this
 * file instead of the root one, while still reusing the exact same shared
 * preset every other package uses.
 */
export default [
  {
    ignores: [
      'dist/**',
      'dist-ledger/**',
      'dist-ledger-auto/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      // Served as-is to the mock page by Playwright route interception
      // (test/e2e/extension.spec.ts) — plain browser JS, never built or
      // typechecked by this package's own toolchain.
      'test/fixtures/mock-ea-app/**',
    ],
  },
  ...base,
  {
    rules: {
      // The extension talks to `chrome.*`/`browser.*` APIs and untyped EA
      // page globals (adapter.ts's ASSUMED SHAPE) throughout — `any` shows up
      // at those boundaries deliberately, guarded at runtime instead of at
      // the type level. Kept a warning, not silenced, everywhere else.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
