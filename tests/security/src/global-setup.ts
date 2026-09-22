// Runs once per vitest invocation, before any test file: applies every
// migration to this package's dedicated test database so a fresh CI
// service container (which only creates the database) has the schema the
// per-file resetDatabase() calls expect. Mirrors apps/api/src/test/global-setup.ts.
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';

config({ path: fileURLToPath(new URL('../../../apps/api/.env', import.meta.url)) });

process.env.NODE_ENV ??= 'test';
process.env.REDIS_TEST_DB ??= '13';
process.env.TEST_DATABASE_URL ??= 'postgres://sl:sl@127.0.0.1:5432/sniper_ledger_test_security';

export default async function globalSetup(): Promise<void> {
  const { migrateTestDatabase } = await import('@sl/db/test-utils');
  await migrateTestDatabase();
}
