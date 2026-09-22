// Discovers every `*.job.ts` (or compiled `*.job.js`) file in this directory
// and returns its default-exported JobDefinition. Plain filesystem scan
// (not @fastify/autoload — jobs are not Fastify plugins) so both `tsx
// src/worker.ts` (dev) and the compiled `dist/worker.js` (prod) pick up the
// same files without a build-time manifest.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { JobDefinition } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadJobs(): Promise<JobDefinition[]> {
  const files = readdirSync(__dirname).filter((f) => /\.job\.(ts|js)$/.test(f));
  const jobs: JobDefinition[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(__dirname, file)).href)) as {
      default: JobDefinition;
    };
    jobs.push(mod.default);
  }
  return jobs;
}

export type { JobContext, JobDefinition } from './types.js';
export { defineJob } from './types.js';
