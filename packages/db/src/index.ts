// Public entry point for @sl/db.
//
// Drizzle here is a *typed query layer only* — schema.ts describes the shape
// of tables that already exist (created by the hand-written SQL files in
// migrations/, applied by src/migrate.ts). We deliberately do not use
// drizzle-kit generate/push: hand-written SQL gives us full control over
// partitioning, partial/BRIN/GIN indexes, CHECK constraints, triggers, views,
// materialized views and role grants — none of which drizzle-kit's schema
// diffing represents faithfully. `createDb()` just wires `drizzle-orm`'s
// query builder up to those same tables so application code gets full
// TypeScript inference (`db.query.users.findFirst(...)`, `db.select()...`)
// without hand-writing SQL for every call site.

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import { schema } from './schema/index.js';

export * from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface CreateDbOptions {
  /** Max pool size (postgres.js connections). Default 10. */
  max?: number;
  /** Enable postgres.js query logging (defaults to false; pino covers app-level logging). */
  debug?: boolean;
  /** ssl option passed through to postgres.js (e.g. 'require' in prod). */
  ssl?: boolean | 'require' | 'prefer' | 'allow' | 'verify-full';
}

/**
 * Creates a Drizzle database client plus the underlying postgres.js `Sql`
 * connection (exposed for raw queries — LISTEN/NOTIFY, `REFRESH MATERIALIZED
 * VIEW CONCURRENTLY`, etc. — and for closing the pool on shutdown).
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): { db: Database; sql: Sql } {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    debug: options.debug ?? false,
    ssl: options.ssl,
  });

  const db = drizzle(sql, { schema });

  return { db, sql };
}

/** Reads DATABASE_URL from env with the documented local-dev default. */
export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger';
}
