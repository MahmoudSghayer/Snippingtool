#!/usr/bin/env tsx
// BullMQ job runner: one Queue + Worker per job definition discovered by
// jobs/index.ts. Runs as a separate process from the HTTP server (`pnpm
// --filter @sl/api worker` / `node dist/worker.js` in prod). A job with a
// `schedule` gets one BullMQ job scheduler, upserted at startup under a
// fixed id, so re-running this on every deploy updates the schedule rather
// than adding a second one.

import { createDb } from '@sl/db';
import { Queue, Worker } from 'bullmq';
import pino from 'pino';
import 'dotenv/config';

import { loadEnv } from './config/env.js';
import { loadJobs } from './jobs/index.js';
import { createMailer } from './lib/mailer.js';
import { createRedisConnection } from './lib/redis-connection.js';

import type { JobContext } from './jobs/types.js';

const schedulerId = (jobName: string) => `${jobName}:scheduled`;

/**
 * Leaves the queue with exactly the job's current schedule: one job
 * scheduler under `schedulerId`, or none for a job without a schedule.
 *
 * BullMQ 5 stored repeatable jobs under a hash of their options, and BullMQ 6
 * reads those as job schedulers too, so after the upgrade each queue still
 * holds its old schedule under that hash (and any older ones a changed cron
 * left behind). Without removing them every scheduled job would run once
 * per leftover schedule. Each queue belongs to one job, so anything else
 * in it is stale.
 */
async function syncSchedule(
  queue: Queue,
  jobName: string,
  schedule: string | undefined,
  log: pino.Logger,
) {
  const keep = schedule ? schedulerId(jobName) : null;
  for (const s of await queue.getJobSchedulers()) {
    if (s.key === keep) continue;
    await queue.removeJobScheduler(s.key);
    log.info({ job: jobName, scheduler: s.key, pattern: s.pattern }, 'removed stale job schedule');
  }
  if (!schedule) return;
  await queue.upsertJobScheduler(
    schedulerId(jobName),
    { pattern: schedule },
    { name: jobName, data: {} },
  );
  log.info({ job: jobName, schedule }, 'scheduled job');
}

async function main() {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, name: '@sl/api-worker' });

  const { db, sql } = createDb(env.DATABASE_URL, { max: 5 });
  // Via the shared factory: a hand-rolled `new Redis(url)` here is what
  // silently killed every scheduled job when Redis moved to TLS.
  const connection = createRedisConnection(env, { maxRetriesPerRequest: null });

  const ctx: JobContext = { db, redis: connection, env, mailer: createMailer(env), log };
  const jobs = await loadJobs();

  const queues: Queue[] = [];
  const workers: Worker[] = [];

  for (const job of jobs) {
    const queue = new Queue(job.name, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
    queues.push(queue);

    await syncSchedule(queue, job.name, job.schedule, log);

    const worker = new Worker(
      job.name,
      async (bullJob) => {
        log.info({ job: job.name, jobId: bullJob.id }, 'job started');
        await job.processor(bullJob, ctx);
        log.info({ job: job.name, jobId: bullJob.id }, 'job completed');
      },
      { connection, concurrency: job.concurrency ?? 1 },
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
