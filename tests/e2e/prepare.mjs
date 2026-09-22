#!/usr/bin/env node
// Resets + migrates + seeds the target database, then builds the `ledger`
// extension target for this run — and does it *before* apps/api's own
// process starts (see playwright.config.ts's first `webServer` entry, which
// chains this script ahead of `tsx src/server.ts` with `&&`).
//
// This was originally Playwright's own `globalSetup` hook instead — moved
// here after confirming empirically (while authoring this suite) that
// Playwright starts every `webServer` entry *before* running `globalSetup`,
// not after: with `globalSetup` doing the DB reset, `apps/api`'s process was
// already up, connected, and answering `/health/ready` by the time the
// reset (`DROP SCHEMA public CASCADE`, packages/db/src/reset.ts) ran against
// the same database — corrupting that already-open connection pool's cached
// relation state for the rest of the run. Chaining this script as a prefix
// to the API's own start command guarantees the reset finishes, and the
// extension is built, before `tsx src/server.ts` ever binds a connection.
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

async function main() {
  const env = { ...process.env, DATABASE_URL, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD };

  if (!SKIP_RESET) {
    console.warn(
      `[tests/e2e prepare] db:reset + seed against ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')} ...`,
    );
    execFileSync('pnpm', ['--filter', '@sl/db', 'db:reset'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env,
    });
    execFileSync('pnpm', ['--filter', '@sl/db', 'seed'], { cwd: repoRoot, stdio: 'inherit', env });
  } else {
    console.warn('[tests/e2e prepare] E2E_SKIP_DB_RESET=1 — reusing the database as-is.');
  }

  console.warn('[tests/e2e prepare] building the ledger extension target for this run...');
  await buildExtension();
  console.warn('[tests/e2e prepare] done.');
}

await main();
