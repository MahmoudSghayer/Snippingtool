// Loads apps/api's own .env (JWT/entitlement keys, DATABASE_URL, etc.) so
// this package's tests boot the exact same app configuration @sl/api's own
// tests do, without duplicating a second copy of those dev secrets. See
// README.md for the env vars to set before running this package standalone
// (TEST_DATABASE_URL, REDIS_TEST_DB).
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';


config({ path: fileURLToPath(new URL('../../../apps/api/.env', import.meta.url)) });

process.env.NODE_ENV ??= 'test';
// A dedicated Redis logical DB, distinct from @sl/api's own test suite's
// default (15, config/env.ts's REDIS_TEST_DB) — so this package can safely
// run in the same environment as (or concurrently with) `pnpm --filter
// @sl/api test` without either flushing the other's in-flight state.
process.env.REDIS_TEST_DB ??= '13';
// A dedicated Postgres test database, distinct from @sl/api's own
// TEST_DATABASE_URL (apps/api/.env's `sniper_ledger_test`) — each file here
// truncates tables between tests the same way @sl/api's own tests do, and
// sharing a database with a concurrently-run @sl/api test run would make
// both suites flaky. Create it once: `createdb sniper_ledger_test_security`
// (owner `sl`) or the `CREATE DATABASE ... OWNER sl` form in README.md; an
// explicit TEST_DATABASE_URL in the environment always wins over this
// default, so CI can point it anywhere.
process.env.TEST_DATABASE_URL ??= 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger_test_security';
