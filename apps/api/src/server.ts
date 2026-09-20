#!/usr/bin/env tsx
// Real process entry point: boots the Fastify app and listens. Use `worker.ts`
// for the BullMQ job runner (a separate process/container in production).

import closeWithGrace from 'close-with-grace';
import 'dotenv/config';

import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

async function main() {
  const env = loadEnv();
  const app = await buildApp();

  closeWithGrace({ delay: 10_000 }, async ({ err }) => {
    if (err) app.log.error({ err }, 'closing app due to error');
    await app.close();
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

main();
