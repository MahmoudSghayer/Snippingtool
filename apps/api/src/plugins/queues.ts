// Lets API routes hand work to the BullMQ worker (src/worker.ts): one Queue
// per job name, created on first use and closed with the app. Jobs added
// here carry their own retry options, because a Queue's defaultJobOptions
// only apply to jobs added through that same Queue instance (the worker's
// copy sets its own for scheduled jobs).

import { Queue } from 'bullmq';
import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    enqueue: (name: string, data: Record<string, unknown>) => Promise<void>;
  }
}

export const ENQUEUE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: 100,
  removeOnFail: 200,
};

export default fp(
  async function queuesPlugin(fastify: FastifyInstance) {
    const queues = new Map<string, Queue>();

    fastify.decorate('enqueue', async (name: string, data: Record<string, unknown>) => {
      let queue = queues.get(name);
      if (!queue) {
        queue = new Queue(name, { connection: fastify.redis });
        queues.set(name, queue);
      }
      await queue.add(name, data, ENQUEUE_JOB_OPTIONS);
    });

    fastify.addHook('onClose', async () => {
      await Promise.all([...queues.values()].map((q) => q.close()));
    });
  },
  { name: 'queues', dependencies: ['redis'] },
);
