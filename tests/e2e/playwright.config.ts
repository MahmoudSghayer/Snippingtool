// Cross-app e2e config (@sl/tests) — see docs/12-testing.md "tests/e2e".
// Runs the real apps/api and apps/dashboard, started here via `webServer`
// (mirrors apps/dashboard/e2e/playwright.config.ts's own approach for
// api+dashboard), against a freshly reset+seeded database. Deliberately on
// different ports from apps/dashboard/e2e's own config (3000/5173) so the
// two suites can run side by side without a port clash if ever invoked in
// the same environment at once.
//
// No BullMQ worker entry: this suite has no assertion that depends on an
// async job completing (every route these journeys touch writes
// synchronously — see each spec's own header). It was tried, briefly — see
// prepare.mjs's own header for why a *second* webServer entry independently
// running the DB reset would race the first one destructively, and running
// the worker without its own reset risks it connecting mid-reset; simplest
// and correct is to not start it in a suite that never needs it. Add it
// back (as `node ../prepare-lock-wait.mjs && ... tsx src/worker.ts`
// polling for a sentinel prepare.mjs writes) if a future journey needs one.
//
// The database reset/seed + extension build (prepare.mjs) runs as a
// *prefix* to the API's own start command, not as Playwright's
// `globalSetup` — see prepare.mjs's header for why: Playwright starts every
// `webServer` entry before running `globalSetup`, not after, so a
// `globalSetup`-driven `DROP SCHEMA` ran (reproduced while authoring this
// config) against a database `apps/api` was already connected to.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

import { EXTENSION_OUT_DIR } from './build-extension.mjs';
import { computeUnpackedExtensionId } from './helpers/extension-id.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..', '..');

export const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
export const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT ?? 5273);
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
// `localhost`, not `127.0.0.1` — see apps/dashboard/playwright.config.ts's
// identical comment: apps/api's CORS allowlist matches the `Origin` header
// by exact string, and this value is what DASHBOARD_ORIGIN below sets it to.
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

// The extension id is deterministic for a fixed unpacked-install path (see
// helpers/extension-id.mjs) — computed here, before Chromium ever loads the
// extension, so it can be baked into apps/api's CORS allowlist
// (EXTENSION_IDS) at webServer start time.
export const EXTENSION_ID = computeUnpackedExtensionId(EXTENSION_OUT_DIR);

const apiEnv = {
  ...process.env,
  DATABASE_URL,
  REDIS_URL,
  PORT: String(API_PORT),
  HOST: '127.0.0.1',
  APP_ORIGIN: API_ORIGIN,
  DASHBOARD_ORIGIN,
  EXTENSION_IDS: EXTENSION_ID,
  // journey (d), subscription-via-webhook: a fixed, known webhook secret +
  // syntactically-valid-but-fake Stripe keys — see helpers/stripe.ts and
  // apps/api/src/modules/payments/__tests__/payments.test.ts's own
  // "never a real network call" pattern. No real Stripe account/network
  // access is used anywhere in this suite.
  STRIPE_SECRET_KEY: 'sk_test_e2e_cross_app_fake_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2e_cross_app_test_secret',
  STRIPE_PRICE_BASIC: 'price_e2e_basic',
  STRIPE_PRICE_PRO: 'price_e2e_pro',
  STRIPE_PRICE_ULTIMATE: 'price_e2e_ultimate',
  STRIPE_PRICE_LIFETIME: 'price_e2e_lifetime',
};

export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // Every journey drives the one seeded admin and/or shares the
  // freshly-reset database's global state (audit log, kill switch toggle) —
  // serialised for the same reason apps/dashboard/e2e's config is.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: DASHBOARD_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
      },
    },
  ],
  webServer: [
    {
      // prepare.mjs (db reset+seed+extension build) runs to completion
      // *before* `tsx src/server.ts` ever starts — see this file's header
      // and prepare.mjs's own for why that ordering has to be enforced by
      // chaining, not by `globalSetup`.
      command: 'node tests/e2e/prepare.mjs && pnpm --filter @sl/api exec tsx src/server.ts',
      cwd: repoRoot,
      url: `${API_ORIGIN}/health/ready`,
      reuseExistingServer: false,
      // Generous on purpose: covers prepare.mjs's own runtime (db reset +
      // seed + a real Vite extension build, ~15-30s) plus tsx's cold
      // compile, which can land alongside heavy concurrent CPU use from
      // another agent's own test run in this shared environment — observed
      // directly while authoring this config.
      timeout: 180_000,
      env: apiEnv,
    },
    {
      // Deliberately does NOT set VITE_API_ORIGIN: apps/dashboard/vite.config.ts
      // only proxies /api,/health,/ws same-origin when that var is unset (see
      // its own comment — cookie auth needs the dashboard's cookie to stay
      // first-party, same as apps/dashboard/e2e/playwright.config.ts's own
      // webServer entry). DEV_API_PROXY_TARGET points that proxy at this
      // run's API instead of its localhost:3000 default.
      // `pnpm --filter @sl/dashboard dev -- --port N` (forwarding through
      // the "dev" script, which is itself just `vite`) was tried first and
      // silently bound vite's *default* port (5173) instead of DASHBOARD_PORT
      // — reproduced while authoring this config: the dev server came up
      // healthy, just on the wrong port, so Playwright's own url health
      // check against DASHBOARD_ORIGIN (5273) timed out even though the
      // dashboard was in fact running. `pnpm exec vite --port N` (skipping
      // the "dev" script's own arg-forwarding) does not have this problem.
      command: `pnpm --filter @sl/dashboard exec vite --port ${DASHBOARD_PORT}`,
      cwd: repoRoot,
      url: DASHBOARD_ORIGIN,
      reuseExistingServer: false,
      timeout: 90_000,
      env: { ...process.env, DEV_API_PROXY_TARGET: API_ORIGIN },
    },
  ],
});
