// Playwright config for the Nova Trade QA audit harness.
//   QA_TARGET=local (default) -> local production-mode stack on :8080
//   QA_TARGET=prod            -> live Vercel dashboard
//
// Auth-dependent specs (02-account, 03-admin) log in ONCE per file into a
// shared serial context, so the whole audit stays within the login rate
// limit (which cannot be raised on production) and avoids the 5-minute
// admin-token / refresh-rotation interplay that breaks per-test reuse.
import { defineConfig, devices } from '@playwright/test';

import { target } from './helpers/targets.ts';

// Pinned UA: refresh tokens are bound to the browser family parsed from the
// User-Agent (apps/api/src/modules/auth/service.ts), so every context must
// present the same one or a refresh revokes the session family mid-run.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 NovaTradeQA/1.0';

export default defineConfig({
  testDir: './specs',
  globalSetup: './helpers/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'out/playwright-report.json' }],
    ['html', { outputFolder: 'out/html-report', open: 'never' }],
  ],
  use: {
    baseURL: target.web,
    userAgent: USER_AGENT,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /07-responsive\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 800 },
        launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
      },
    },
    {
      name: 'mobile',
      testMatch: /07-responsive\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        userAgent: USER_AGENT,
        launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
      },
    },
  ],
});
