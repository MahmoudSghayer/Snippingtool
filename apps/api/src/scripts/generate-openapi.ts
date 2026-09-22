#!/usr/bin/env tsx
/* eslint-disable no-console -- CLI script */
// Builds the app (without listening) and writes its generated OpenAPI
// document to apps/api/openapi/openapi.json. Run via `pnpm --filter @sl/api
// openapi`; the output is committed so the dashboard's typed client
// (openapi-typescript) and docs/03-api.md can both be generated from it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import { buildApp } from '../app.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function main() {
  const app = await buildApp({ logger: false });
  await app.ready();

  const spec = app.swagger();
  const outPath = join(__dirname, '..', '..', 'openapi', 'openapi.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${outPath}`);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
