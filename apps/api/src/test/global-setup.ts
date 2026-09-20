// vitest globalSetup: applies every @sl/db migration to the test database
// once before any test file runs (mirrors packages/db/test/global-setup.ts).
// Individual test files reset table contents between tests via
// resetDatabase() from @sl/db's test-utils.

import 'dotenv/config';
import { migrateTestDatabase } from '@sl/db/test-utils';

export default async function setup() {
  process.env.NODE_ENV ??= 'test';
  await migrateTestDatabase();
}
