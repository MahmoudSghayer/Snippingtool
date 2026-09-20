import fp from 'fastify-plugin';

import { createMailer, type Mailer } from '../lib/mailer.js';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    mailer: Mailer;
  }
}

export default fp(
  async function mailerPlugin(fastify: FastifyInstance) {
    fastify.decorate('mailer', createMailer(fastify.config));
  },
  { name: 'mailer', dependencies: ['config'] },
);
