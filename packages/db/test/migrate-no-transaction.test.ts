import 'dotenv/config';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isNoTransactionMigration, splitStatements, up } from '../src/migrate.js';
import { getTestDatabaseUrl } from '../src/test-utils.js';

// A `-- migrate:no-transaction` file must reach Postgres outside a
// transaction block, or CREATE INDEX CONCURRENTLY is refused. Runs against a
// throwaway database so the real schema_migrations list is untouched.

const dbName = `migrate_notx_${process.pid}_${Date.now()}`;
const baseUrl = new URL(getTestDatabaseUrl());
const scratchUrl = (() => {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

describe('migrate: no-transaction migrations', () => {
  let dir: string;
  const admin = postgres(baseUrl.toString(), { max: 1 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    dir = mkdtempSync(path.join(tmpdir(), 'migrations-'));
    writeFileSync(
      path.join(dir, '0001_table.sql'),
      'CREATE TABLE things (id int PRIMARY KEY, name text);\nINSERT INTO things SELECT g, g::text FROM generate_series(1, 100) g;\n',
    );
    writeFileSync(
      path.join(dir, '0002_index.sql'),
      [
        '-- migrate:no-transaction',
        '-- Build without locking writes on a large table.',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS things_name_idx ON things (name);',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS things_name_id_idx',
        '  ON things (name, id);',
        '',
      ].join('\n'),
    );
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it('applies CREATE INDEX CONCURRENTLY and records the file once', async () => {
    await up(scratchUrl, { migrationsDir: dir });
    await up(scratchUrl, { migrationsDir: dir }); // second run skips both

    const sql = postgres(scratchUrl, { max: 1 });
    try {
      const indexes = await sql`
        SELECT indexname FROM pg_indexes WHERE tablename = 'things' ORDER BY indexname`;
      expect(indexes.map((r) => r.indexname)).toEqual([
        'things_name_id_idx',
        'things_name_idx',
        'things_pkey',
      ]);
      const valid = await sql`
        SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname LIKE 'things_name%' AND i.indisvalid`;
      expect(valid[0]!.n).toBe(2);
      const applied = await sql`SELECT filename FROM schema_migrations ORDER BY filename`;
      expect(applied.map((r) => r.filename)).toEqual(['0001_table.sql', '0002_index.sql']);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('recognises the marker only on the first line', () => {
    expect(isNoTransactionMigration('-- migrate:no-transaction\nSELECT 1;')).toBe(true);
    expect(isNoTransactionMigration('SELECT 1;\n-- migrate:no-transaction')).toBe(false);
  });

  it('splits statements, drops comments, and refuses $$ bodies', () => {
    expect(splitStatements('-- c\nSELECT 1;\nSELECT\n  2;\n')).toEqual(['SELECT 1', 'SELECT\n  2']);
    expect(() => splitStatements('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$;')).toThrow(
      '$$',
    );
  });
});
