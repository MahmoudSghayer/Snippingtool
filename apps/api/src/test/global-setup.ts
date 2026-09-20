// vitest globalSetup: applies every @sl/db migration to the test database
// once before any test file runs (mirrors packages/db/test/global-setup.ts),
// and flushes the dedicated test Redis DB (see plugins/redis.ts) so state
// left behind by a crashed previous run never leaks in. Individual test
// files reset table contents between tests via resetDatabase() from
// @sl/db's test-utils.

import { migrateTestDatabase } from '@sl/db/test-utils';
import { Redis } from 'ioredis';

import 'dotenv/config';

// Mirrors plugins/redis.ts's REDIS_TEST_DB (config/env.ts, default 15) —
// this file runs outside buildApp()/loadEnv(), so it reads process.env
// directly rather than fastify.config, but must land on the exact same
// logical DB plugins/redis.ts will connect every test file's app.redis to,
// or the FLUSHDB below isolates nothing.
const TEST_REDIS_DB = Number(process.env.REDIS_TEST_DB ?? 15);

export default async function setup() {
  process.env.NODE_ENV ??= 'test';
  await migrateTestDatabase();

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { db: TEST_REDIS_DB, maxRetriesPerRequest: 1 });
  await redis.flushdb();
  redis.disconnect();
}
