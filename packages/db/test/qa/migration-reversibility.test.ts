// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
//
// Verifies the migrator's `down/` files are a genuine reverse of `up`: every
// migration can be rolled back in reverse-applied order down to an empty
// schema, then the whole set re-applied, ending in the same fully-migrated
// state. This is destructive (drops every table), so it runs against its
// own dedicated database — never the shared TEST_DATABASE_URL other
// packages' suites use — via an explicit connection string, matching the
// QA agent's environment note in docs/12-testing.md ("own test DB:
// sniper_ledger_test_qa"). Create it once:
//   sudo -u postgres psql -c "CREATE DATABASE sniper_ledger_test_qa OWNER sl;"
//
// `migrate.ts`'s `down()` only ever rolls back the single most-recently-
// applied migration (by design — see its own header comment), so "apply in
// reverse" here means calling it once per migration file.
//
// 0001's down file is deliberately excluded from the rollback loop: it
// drops the `app_rw`/`app_ro` roles and the `pgcrypto`/`citext` extensions,
// which are cluster-global (not per-database) in Postgres. This repo's
// local cluster runs several sibling test databases concurrently (this
// QA suite's own, plus @sl/api's, @sl/security-tests', and other agents'),
// all granted to the same two role names — dropping them from *this*
// database's down migration would fail (and, if it somehow didn't, would
// break every other database on the same cluster). 0001's own down file
// comment says as much ("best-effort... fails loudly by design if any
// object still has a GRANT outstanding") and confirms this is expected,
// not a defect: rolling back migrations 0002-0025 in reverse and verifying
// every application table 0002+ created is gone is still a real, complete
// test of "down is a genuine reverse of up" for everything down() can
// safely be exercised against in a shared-cluster environment.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { down, up } from '../../src/migrate';

// Resolution order: an explicit QA_TEST_DATABASE_URL wins; otherwise derive
// a sibling database from TEST_DATABASE_URL (or the documented local
// default) by suffixing its name with `_reversibility`, and create it if it
// does not exist yet (CI service containers only create one database).
const BASE_TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger_test';

function deriveQaDatabaseUrl(base: string): { url: string; name: string } {
  const u = new URL(base);
  const name = `${u.pathname.replace(/^\//, '')}_reversibility`;
  u.pathname = `/${name}`;
  return { url: u.toString(), name };
}

const derived = deriveQaDatabaseUrl(BASE_TEST_URL);
const QA_DATABASE_URL = process.env.QA_TEST_DATABASE_URL ?? derived.url;

async function ensureQaDatabaseExists(): Promise<void> {
  if (process.env.QA_TEST_DATABASE_URL) return; // caller owns its lifecycle
  const admin = postgres(BASE_TEST_URL, { max: 1 });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${derived.name}`;
    if (rows.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${derived.name}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

// A representative, not exhaustive, spot-check of tables from early/mid/late
// migrations — enough to catch "down didn't actually drop anything" or "up
// after down silently skipped something" without re-asserting the full
// EXPECTED_TABLES list schema.test.ts already owns.
const SPOT_CHECK_TABLES = [
  'users',
  'sessions',
  'subscriptions',
  'trades',
  'audit_logs',
  'analytics_daily',
];

describe('migration reversibility (down applies in reverse, then re-applies cleanly)', () => {
  const sql = postgres(QA_DATABASE_URL, { max: 1 });
  const allFiles = listMigrationFiles();

  beforeAll(async () => {
    await ensureQaDatabaseExists();
    // Start from a known-good, fully-migrated state regardless of what a
    // previous run of this file (or a crashed run) left behind.
    await up(QA_DATABASE_URL);
  });

  afterAll(async () => {
    // Always leave the QA database fully migrated for any other suite that
    // might reuse it, even if an assertion above failed mid-rollback.
    await up(QA_DATABASE_URL);
    await sql.end({ timeout: 5 });
  });

  it('starts fully migrated (all 25 files recorded)', async () => {
    const rows = await sql<
      { filename: string }[]
    >`SELECT filename FROM schema_migrations ORDER BY filename`;
    expect(rows.map((r) => r.filename)).toEqual(allFiles);
  });

  it('rolls back every migration but 0001 (cluster-global roles/extensions) one at a time, in reverse order', async () => {
    for (let i = allFiles.length - 1; i >= 1; i--) {
      const expectedFile = allFiles[i]!;

      const before = await sql<
        { filename: string }[]
      >`SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`;
      expect(
        before[0]?.filename,
        `expected ${expectedFile} to be the most-recently-applied migration before rolling it back`,
      ).toBe(expectedFile);

      await expect(
        down(QA_DATABASE_URL),
        `down() should not throw while rolling back ${expectedFile}`,
      ).resolves.toBeUndefined();

      // expectedFile always comes from this file's own listMigrationFiles()
      // (never request input) — plain identifiers ending in `.sql`, safe to
      // inline via sql.unsafe(), same convention as fk-delete-behaviors.test.ts.
      if (!/^[\w.-]+\.sql$/.test(expectedFile))
        throw new Error(`refusing to interpolate an unexpected filename into SQL: ${expectedFile}`);
      const remaining = (await sql.unsafe(
        `SELECT filename FROM schema_migrations WHERE filename = '${expectedFile}'`,
      )) as unknown as Array<{ filename: string }>;
      expect(
        remaining,
        `${expectedFile} should no longer be recorded as applied after its own down`,
      ).toHaveLength(0);
    }

    // Only 0001 (extensions/functions/roles, no tables) remains recorded.
    const remainingFiles = await sql<
      { filename: string }[]
    >`SELECT filename FROM schema_migrations ORDER BY filename`;
    expect(remainingFiles.map((r) => r.filename)).toEqual([allFiles[0]]);

    // Every application table 0002+ created should be gone — `down` files
    // are a real, complete reverse, not a partial no-op. 0001 itself never
    // creates any table (only extensions/functions/roles), so this is
    // still a genuinely empty-of-application-tables assertion.
    const tables = await sql<
      { tablename: string }[]
    >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const remainingTableNames = tables
      .map((t) => t.tablename)
      .filter((name) => name !== 'schema_migrations');
    expect(
      remainingTableNames,
      `expected no application tables left after rolling back every migration but 0001, found: ${remainingTableNames.join(', ')}`,
    ).toEqual([]);
  });

  it('re-applies every migration from empty and ends fully migrated again', async () => {
    await up(QA_DATABASE_URL);

    const rows = await sql<
      { filename: string }[]
    >`SELECT filename FROM schema_migrations ORDER BY filename`;
    expect(rows.map((r) => r.filename)).toEqual(allFiles);

    for (const table of SPOT_CHECK_TABLES) {
      // table always comes from this file's own SPOT_CHECK_TABLES literal above.
      if (!/^[a-z_]+$/.test(table))
        throw new Error(`refusing to interpolate an unexpected identifier into SQL: ${table}`);
      const exists = (await sql.unsafe(
        `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}') AS exists`,
      )) as unknown as Array<{ exists: boolean }>;
      expect(
        exists[0]?.exists,
        `expected table "${table}" to exist after re-applying every migration`,
      ).toBe(true);
    }

    // Re-running `up` again on an already-fully-migrated database is a no-op
    // (idempotent) — this is the same guarantee src/migrate.ts documents.
    await expect(up(QA_DATABASE_URL)).resolves.toBeUndefined();
  });
});
