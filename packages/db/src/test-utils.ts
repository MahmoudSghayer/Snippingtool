// Test-database helpers for @sl/db's own vitest suite and for the API's
// integration tests (`import { resetDatabase, createTestDb } from '@sl/db'`).
//
// These deliberately don't hard-code a database name: they derive the test
// database URL from TEST_DATABASE_URL, falling back to swapping the last path
// segment of DATABASE_URL for "_test" — matching the sniper_ledger /
// sniper_ledger_test pair this repo's local Postgres runs.

import { sql as sqlTag } from 'drizzle-orm';
import { createDb, getDatabaseUrl, type Database } from './index';
import { up } from './migrate';

export function getTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  const base = getDatabaseUrl(env);
  // postgres://user:pass@host:port/dbname -> .../dbname_test (idempotent if
  // the base URL already points at a database already ending in _test).
  return base.endsWith('_test') ? base : `${base}_test`;
}

/** Creates a Drizzle client against the test database. */
export function createTestDb(): { db: Database; sql: ReturnType<typeof createDb>['sql'] } {
  return createDb(getTestDatabaseUrl());
}

/** Applies every migration to the test database (idempotent — see migrate.ts). */
export async function migrateTestDatabase(): Promise<void> {
  await up(getTestDatabaseUrl());
}

// Tables to leave alone on a reset: the migrator's own bookkeeping table.
// Everything else in `public` is a real application table, view or
// materialized view and either gets truncated or skipped below.
const SKIP_TABLES = new Set(['schema_migrations']);

/**
 * Truncates every application table in the test database, respecting FKs
 * (TRUNCATE ... CASCADE across all tables in one statement, so ordering
 * doesn't matter), and resets identity/serial sequences. Partition children
 * are truncated implicitly by truncating their parent. Safe to call between
 * tests/suites; does not drop or recreate schema (use db:reset for that).
 */
export async function resetDatabase(db: Database): Promise<void> {
  const tables = await db.execute<{ tablename: string }>(sqlTag`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '%\_y____m__'  -- skip partition children, truncated via their parent
      AND tablename NOT LIKE '%\_default'
  `);

  const names = tables
    .map((r) => r.tablename)
    .filter((name) => !SKIP_TABLES.has(name));

  if (names.length === 0) return;

  const identifiers = names.map((n) => `"${n}"`).join(', ');
  await db.execute(sqlTag.raw(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`));
}

/** Closes the underlying postgres.js connection pool. Call in afterAll(). */
export async function closeTestDb(sqlClient: ReturnType<typeof createDb>['sql']): Promise<void> {
  await sqlClient.end({ timeout: 5 });
}
