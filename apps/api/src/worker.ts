#!/usr/bin/env tsx
// BullMQ job runner: one Queue + Worker per job definition discovered by
// jobs/index.ts. Runs as a separate process from the HTTP server (`pnpm
// --filter @sl/api worker` / `node dist/worker.js` in prod). Repeatable jobs
// (those with a `schedule`) get their cron added to the queue once at
// startup — BullMQ's repeatable-job keys are content-addressed, so
// re-running this on every deploy does not create duplicate schedules.

import { createDb } from '@sl/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import 'dotenv/config';

import { loadEnv } from './config/env.js';
import { loadJobs } from './jobs/index.js';
import { createMailer } from './lib/mailer.js';

import type { JobContext } from './jobs/types.js';

async function main() {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, name: '@sl/api-worker' });

  const { db, sql } = createDb(env.DATABASE_URL, { max: 5 });
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const ctx: JobContext = { db, redis: connection, env, mailer: createMailer(env), log };
  const jobs = await loadJobs();

  const queues: Queue[] = [];
  const workers: Worker[] = [];

  for (const job of jobs) {
    const queue = new Queue(job.name, {
      connection,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 50, removeOnFail: 100 },
    });
    queues.push(queue);

    if (job.schedule) {
      await queue.add(job.name, {}, { repeat: { pattern: job.schedule }, jobId: `${job.name}:scheduled` });
      log.info({ job: job.name, schedule: job.schedule }, 'scheduled repeatable job');
    }

    const worker = new Worker(
      job.name,
      async (bullJob) => {
        log.info({ job: job.name, jobId: bullJob.id }, 'job started');
        await job.processor(bullJob, ctx);
        log.info({ job: job.name, jobId: bullJob.id }, 'job completed');
      },
      { connection, concurrency: 1 },
    );
    worker.on('failed', (bullJob, err) => {
      log.error({ job: job.name, jobId: bullJob?.id, err }, 'job failed');
    });
    workers.push(worker);
  }

  log.info({ jobCount: jobs.length }, 'worker started');

  const shutdown = async () => {
    log.info('worker shutting down');
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(queues.map((q) => q.close()));
    connection.disconnect();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
