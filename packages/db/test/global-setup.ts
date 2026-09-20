// vitest globalSetup: applies every migration to the test database once,
// before any test file runs. Individual test files reset table contents
// (test-utils.resetDatabase) as needed between tests/suites.

import 'dotenv/config';
import { migrateTestDatabase } from '../src/test-utils';

export default async function setup() {
  await migrateTestDatabase();
}
