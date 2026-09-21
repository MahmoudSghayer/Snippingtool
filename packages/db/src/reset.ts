#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI script: progress output to the terminal is the point. */
// db:reset — drops and recreates the `public` schema on the target database
// (DATABASE_URL), then re-applies every migration from scratch. Destructive;
// intended for local dev and the test database, never production.

import postgres from 'postgres';

import 'dotenv/config';
import { up } from './migrate.js';

import { getDatabaseUrl } from './index.js';

async function main() {
  const url = getDatabaseUrl();

  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run db:reset with NODE_ENV=production.');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });
  try {
    console.log(
      `Dropping and recreating schema "public" on ${url.replace(/:[^:@]*@/, ':***@')} ...`,
    );
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
    console.log('Schema reset.');
  } finally {
    await sql.end({ timeout: 5 });
  }

  await up(url);
}

await main();
