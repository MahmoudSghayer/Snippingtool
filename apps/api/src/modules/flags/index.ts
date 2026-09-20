// No user-facing HTTP routes — flags are written by `modules/subscriptions`
// (trial abuse) and the `abuse.scan` job, and reviewed exclusively through
// `modules/admin-flags`. `index.ts` still exists (registering zero routes)
// so this folder follows the mandatory one-folder-per-module convention.

import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

export default fp(async function flagsModule(_fastify: FastifyInstance) {}, { name: 'module:flags' });
