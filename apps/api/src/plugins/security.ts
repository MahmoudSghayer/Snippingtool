// @fastify/helmet: CSP, HSTS, X-Content-Type-Options: nosniff, X-Frame-Options
// DENY, etc. The API serves JSON only (no HTML views), so CSP is locked down
// to 'none' by default.

import helmet from '@fastify/helmet';
import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

export default fp(
  async function securityPlugin(fastify: FastifyInstance) {
    await fastify.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: fastify.config.NODE_ENV === 'production' ? { maxAge: 15552000, includeSubDomains: true } : false,
    });
  },
  { name: 'security', dependencies: ['config'] },
);
