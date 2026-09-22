// Playwright e2e config. Runs against the *real* API (apps/api) on the
// seeded dev Postgres/Redis, not a mock — see docs/07-dashboard.md "Testing"
// for the exact local procedure this mirrors (and the two-terminal fallback
// if the webServer-managed processes below prove unreliable in a given
// environment).
import { defineConfig, devices } from '@playwright/test';

const API_PORT = 3000;
const DASHBOARD_PORT = 5173;
// `localhost`, not `127.0.0.1`: apps/api's CORS allowlist (plugins/cors.ts)
// matches the `Origin` header by exact string, and DASHBOARD_ORIGIN below is
// passed to the API's webServer entry precisely so this always matches
// regardless of what's in apps/api/.env — "127.0.0.1" and "localhost" are
// different origins to a browser even though they resolve to the same host,
// and that mismatch is exactly what broke this suite once during authoring.
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Every spec file authenticates as the one seeded admin (device limit 1,
  // and TOTP enrollment is a one-time, order-dependent flow across the
  // whole run — see e2e/helpers/adminAuth.ts) — `workers: 1` guarantees
  // spec files run strictly one after another, not concurrently, which
  // `fullyParallel: false` alone does not (it only serialises tests
  // *within* a file).
  workers: 1,
  retries: 0,
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
        // This environment's Chromium is pre-installed outside Playwright's
        // own managed browser cache — `pnpm exec playwright install` is
        // neither available nor needed.
        launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
      },
    },
  ],
  webServer: [
    {
      // `tsx src/server.ts` directly, not `pnpm --filter @sl/api dev`
      // (`tsx watch`): watch mode restarts the process on any file change
      // under its scope — including unrelated writes elsewhere in the repo
      // during a long-running test session — which drops in-flight requests
      // mid-test. The e2e suite doesn't edit apps/api, so it never needs
      // the restart-on-change behaviour anyway.
      command: 'pnpm --filter @sl/api exec tsx src/server.ts',
      cwd: '../..',
      url: `http://127.0.0.1:${API_PORT}/health/ready`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        DATABASE_URL,
        REDIS_URL,
        DASHBOARD_ORIGIN,
        // Defect #10 follow-up (docs/12-testing.md "Defects found" — the
        // screenshot-inventory gap docs/10-design-system.md §14 used to
        // note as "blocked by rate limit"): this whole spec re-uses one
        // browser context/device across every route, every breakpoint —
        // `visual-smoke.spec.ts` alone makes dozens of requests well inside
        // apps/api's default RATE_LIMIT_GLOBAL_MAX (300/60s), and
        // `dashboard.spec.ts`/`accessibility.spec.ts` each re-authenticate
        // the same seeded admin on top of that within the same run
        // (`workers: 1`, so they don't overlap, but the requests still
        // accumulate against the same per-IP window). Both knobs are
        // already env-configurable (config/env.ts) — this just sets them
        // generously for this run instead of leaving the (correct,
        // production-appropriate) defaults to occasionally 429 a long e2e
        // session.
        RATE_LIMIT_GLOBAL_MAX: '100000',
        RATE_LIMIT_GLOBAL_WINDOW_MS: '60000',
        RATE_LIMIT_LOGIN_MAX: '100000',
        RATE_LIMIT_LOGIN_WINDOW_MS: '60000',
      },
    },
    {
      command: 'pnpm --filter @sl/dashboard dev',
      cwd: '../..',
      url: DASHBOARD_ORIGIN,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
