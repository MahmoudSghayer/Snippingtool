import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

export default fp(
  async function cookiePlugin(fastify: FastifyInstance) {
    await fastify.register(cookie, {
      secret: fastify.config.COOKIE_SECRET,
      hook: 'onRequest',
    });
  },
  { name: 'cookie', dependencies: ['config'] },
);
