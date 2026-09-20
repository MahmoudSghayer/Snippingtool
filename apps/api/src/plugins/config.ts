// Decorates the Fastify instance with the validated env (`fastify.config`).
// Registered first, before anything else that reads it.

import fp from 'fastify-plugin';

import { loadEnv, type Env } from '../config/env.js';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    config: Env;
  }
}

export default fp(
  async function configPlugin(fastify: FastifyInstance) {
    fastify.decorate('config', loadEnv());
  },
  { name: 'config' },
);
