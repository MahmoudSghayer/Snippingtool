// Runs once before the whole tests/e2e run: resets + migrates + seeds the
// target database (DATABASE_URL — the dev DB, sniper_ledger, by default; see
// docs/12-testing.md "tests/e2e" for why a *fresh* reset+seed and not the
// dev DB's current live state — this suite's journeys assert on rows that
// must not already exist, e.g. "the seeded admin's audit log has exactly
// this one new entry"), then builds the `ledger` extension target pointed
// at this run's API origin (tests/e2e's own build, not
// apps/extension/dist/ledger — see build-extension.mjs's header for why a
// separate build is needed).
//
// apps/api, apps/api's worker and apps/dashboard are started by
// playwright.config.ts's `webServer` array (like apps/dashboard/e2e's own
// config does for api+dashboard) rather than hand-rolled here — Playwright
// already health-checks, retries and tears each one down for us; this file
// is only what needs to run strictly *before* any of them start (the reset)
// or that they don't cover (the extension build).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExtension } from './build-extension.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '..', '..');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger';
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@sniperledger.local';
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin-Passw0rd!';

// Skips the destructive reset when explicitly asked to (E2E_SKIP_DB_RESET=1)
// — see docs/12-testing.md, "running this locally against a database other
// agents/processes are also using": a full `DROP SCHEMA public CASCADE`
// (packages/db/src/reset.ts) is exactly what you do NOT want to run against
// a database anything else in the same environment currently depends on.
// CI always resets (dedicated ephemeral Postgres service container, nothing
// else attached to it) and never sets this.
const SKIP_RESET = process.env.E2E_SKIP_DB_RESET === '1';

export default async function globalSetup(): Promise<void> {
  const env = { ...process.env, DATABASE_URL, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD };

  if (!SKIP_RESET) {
    console.log(`[tests/e2e globalSetup] db:reset + seed against ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')} ...`);
    execFileSync('pnpm', ['--filter', '@sl/db', 'db:reset'], { cwd: repoRoot, stdio: 'inherit', env });
    execFileSync('pnpm', ['--filter', '@sl/db', 'seed'], { cwd: repoRoot, stdio: 'inherit', env });
  } else {
    console.log('[tests/e2e globalSetup] E2E_SKIP_DB_RESET=1 — reusing the database as-is.');
  }

  console.log('[tests/e2e globalSetup] building the ledger extension target for this run...');
  await buildExtension();
}
