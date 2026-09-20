// vitest globalSetup: applies every @sl/db migration to the test database
// once before any test file runs (mirrors packages/db/test/global-setup.ts),
// and flushes the dedicated test Redis DB (see plugins/redis.ts) so state
// left behind by a crashed previous run never leaks in. Individual test
// files reset table contents between tests via resetDatabase() from
// @sl/db's test-utils.

import { migrateTestDatabase } from '@sl/db/test-utils';
import { Redis } from 'ioredis';

import 'dotenv/config';

const TEST_REDIS_DB = 15;

export default async function setup() {
  process.env.NODE_ENV ??= 'test';
  await migrateTestDatabase();

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { db: TEST_REDIS_DB, maxRetriesPerRequest: 1 });
  await redis.flushdb();
  redis.disconnect();
}
