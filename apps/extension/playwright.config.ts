import { defineConfig } from '@playwright/test';

/**
 * Extension loading (`--load-extension`) needs a persistent context, which
 * `test/e2e/extension.spec.ts` creates itself rather than through
 * Playwright's `use.launchOptions` — see that file for why, and
 * docs/06-extension.md ("Day-one verification checklist" / running this
 * suite locally) for how to run it headed with a real display, and how to
 * run it here with `xvfb-run` since this container has no display of its
 * own.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
