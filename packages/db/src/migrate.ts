#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI script: progress output to the terminal is the point. */
// Hand-written-SQL migrator. Applies every *.sql file in migrations/ (sorted
// lexically, so the NNNN_ prefix controls order) inside its own transaction,
// and records what has been applied in a `schema_migrations` table. Re-running
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

function listUpMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
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

export async function up(connectionString: string = getDatabaseUrl()) {
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

    const files = listUpMigrations();
    let appliedCount = 0;

    for (const file of files) {
      const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
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

      console.log(`Applying ${file} ...`);
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${sum})`;
      });
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
