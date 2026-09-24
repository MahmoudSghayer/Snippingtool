// The jobs convention: every `src/jobs/*.job.ts` file default-exports a
// JobDefinition. `src/jobs/index.ts` discovers them (no @fastify/autoload
// here — jobs run in worker.ts, outside the Fastify instance), and
// worker.ts wires each one to a BullMQ Queue + Worker, adding the
// repeatable schedule (if any) once at startup (idempotent — BullMQ
// dedupes identical repeat jobs by key).

import type { Env } from '../config/env.js';
import type { Mailer } from '../lib/mailer.js';
import type { Database } from '@sl/db';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

export interface JobContext {
  db: Database;
  redis: Redis;
  env: Env;
  /** Lazily constructed on first access (most jobs never send mail) — see
   * worker.ts. Real SMTP in production, in-memory JSON transport in
   * dev/test, same as the API process's `fastify.mailer`. */
  mailer: Mailer;
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

export interface JobDefinition<TData = unknown> {
  /** Queue/job name, also the BullMQ queue name — must be unique. */
  name: string;
  /** Cron expression for a repeatable job. Omit for a job only ever
   * triggered manually/by another job (`queue.add`). */
  schedule?: string;
  /** Jobs of this queue a worker process runs at once. Default 1, which is
   * right for anything scheduled or order-sensitive; raise it for queues of
   * independent, I/O-bound jobs (e.g. sending email) so a burst drains in
   * parallel instead of one at a time. */
  concurrency?: number;
  /** Runs once per invocation. Throwing marks the BullMQ job failed (and
   * retried per its `attempts` option, default 3 set in worker.ts). */
  processor: (job: Job<TData>, ctx: JobContext) => Promise<void>;
}

export function defineJob<TData = unknown>(def: JobDefinition<TData>): JobDefinition<TData> {
  return def;
}
