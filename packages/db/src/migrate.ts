#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI script: progress output to the terminal is the point. */
// Hand-written-SQL migrator. Applies every *.sql file in migrations/ (sorted
// lexically, so the NNNN_ prefix controls order) inside its own transaction,
// and records what has been applied in a `schema_migrations` table.
//
// A file whose first line is `-- migrate:no-transaction` runs outside a
// transaction instead, one statement at a time. That's the only way to use
// statements Postgres refuses inside a transaction block, above all
// `CREATE INDEX CONCURRENTLY`, which builds an index on a large table without
// locking out writes (an ordinary CREATE INDEX on `users` would block every
// login until it finished). Rules for such a file, enforced below:
//   - one statement per `;`-terminated line group, no `$$` bodies
//   - nothing that needs atomicity: if statement 2 of 3 fails, statement 1
//     stays applied and the file is not recorded, so write statements that
//     are safe to re-run (`CREATE INDEX CONCURRENTLY IF NOT EXISTS`, and drop
//     an INVALID index left by a failed build before retrying). Re-running
// is safe: already-applied files are skipped. `down` applies the matching
// files in migrations/down/ in reverse order for the migrations currently
// recorded as applied (best-effort — see the down/ file headers).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres, { type Sql } from 'postgres';

import 'dotenv/config';
import { getDatabaseUrl } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const DOWN_DIR = join(MIGRATIONS_DIR, 'down');

function listUpMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

const NO_TRANSACTION_MARKER = /^--\s*migrate:no-transaction\s*$/;

export function isNoTransactionMigration(content: string): boolean {
  return NO_TRANSACTION_MARKER.test(content.split('\n', 1)[0]!.trim());
}

/** Splits a no-transaction migration into its statements: drops `--` comment
 * lines, then splits on a `;` that ends a line. Deliberately simple; the
 * format is restricted to statements that fit it. */
export function splitStatements(content: string): string[] {
  if (content.includes('$$')) {
    throw new Error(
      'A migrate:no-transaction file cannot contain $$-quoted bodies; put functions in a normal migration.',
    );
  }
  return content
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function ensureMigrationsTable(sql: Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text NOT NULL
    )
  `;
}

function checksum(content: string): string {
  // Content fingerprint used only to flag "this applied file's content
  // changed on disk since it was applied" — not a security control.
  return createHash('sha256').update(content).digest('hex');
}

export async function up(
  connectionString: string = getDatabaseUrl(),
  options: { migrationsDir?: string } = {},
) {
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const url = connectionString;
  const sql = postgres(url, { max: 1 });
  try {
    await ensureMigrationsTable(sql);
    const applied = new Map(
      (await sql`SELECT filename, checksum FROM schema_migrations`).map((r) => [
        r.filename as string,
        r.checksum as string,
      ]),
    );

    const files = listUpMigrations(migrationsDir);
    let appliedCount = 0;

    for (const file of files) {
      const content = readFileSync(join(migrationsDir, file), 'utf8');
      const sum = checksum(content);

      if (applied.has(file)) {
        const prevSum = applied.get(file);
        if (prevSum !== sum) {
          console.warn(
            `WARNING: ${file} was already applied but its content on disk has changed since. Not re-applying (migrations are immutable once applied). Create a new migration instead.`,
          );
        }
        continue;
      }

      if (isNoTransactionMigration(content)) {
        console.log(`Applying ${file} (no transaction) ...`);
        for (const statement of splitStatements(content)) {
          await sql.unsafe(statement);
        }
        await sql.unsafe('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          file,
          sum,
        ]);
      } else {
        console.log(`Applying ${file} ...`);
        await sql.begin(async (tx) => {
          await tx.unsafe(content);
          await tx`INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${sum})`;
        });
      }
      appliedCount++;
      console.log(`Applied ${file}`);
    }

    if (appliedCount === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Applied ${appliedCount} migration(s).`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function status(connectionString: string = getDatabaseUrl()) {
  const url = connectionString;
  const sql = postgres(url, { max: 1 });
  try {
    await ensureMigrationsTable(sql);
    const applied = new Set(
      (await sql`SELECT filename FROM schema_migrations`).map((r) => r.filename as string),
    );
    const files = listUpMigrations();

    console.log('Migration status:');
    for (const file of files) {
      console.log(`  [${applied.has(file) ? 'x' : ' '}] ${file}`);
    }
    const pending = files.filter((f) => !applied.has(f));
    console.log(`\n${applied.size} applied, ${pending.length} pending.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function down(connectionString: string = getDatabaseUrl()) {
  const url = connectionString;
  const sql = postgres(url, { max: 1 });
  try {
    await ensureMigrationsTable(sql);
    const applied = (await sql`SELECT filename FROM schema_migrations ORDER BY filename DESC`).map(
      (r) => r.filename as string,
    );

    if (applied.length === 0) {
      console.log('No applied migrations to roll back.');
      return;
    }

    const last = applied[0]!;
    const downFile = join(DOWN_DIR, last);
    console.log(`Rolling back ${last} using ${downFile} (best-effort) ...`);

    const content = readFileSync(downFile, 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`DELETE FROM schema_migrations WHERE filename = ${last}`;
    });
    console.log(`Rolled back ${last}.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run the CLI when this file is executed directly (`tsx src/migrate.ts ...`),
// not when `up`/`status`/`down` are imported programmatically (e.g. by
// src/reset.ts or test-utils.ts).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'up':
      await up();
      break;
    case 'status':
      await status();
      break;
    case 'down':
      await down();
      break;
    default:
      console.error('Usage: tsx src/migrate.ts <up|status|down>');
      process.exit(1);
  }
}
