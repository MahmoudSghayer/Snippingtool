// @fastify/rate-limit with a Redis store, so rate limits are shared across
// API instances. Global default here (RATE_LIMIT_GLOBAL_*); stricter,
// route-specific limits (login, register, password reset) are applied
// per-route in modules/auth via the `config.rateLimit` route option, which
// @fastify/rate-limit supports overriding per-route.

import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';

import { AppErrors } from '../lib/errors.js';

import type { FastifyInstance } from 'fastify';

export default fp(
  async function rateLimitPlugin(fastify: FastifyInstance) {
    await fastify.register(rateLimit, {
      global: true,
      max: fastify.config.RATE_LIMIT_GLOBAL_MAX,
      timeWindow: fastify.config.RATE_LIMIT_GLOBAL_WINDOW_MS,
      redis: fastify.redis,
      nameSpace: 'rl:',
      keyGenerator: (request) => request.ip,
      // @fastify/rate-limit `throw`s whatever this returns (see its
      // source — not a `reply.send()`), so returning the AppError instance
      // itself means it lands in plugins/error-handler.ts's `isAppError`
      // branch with the correct status/code/message/details, exactly like
      // an AppError thrown from a route handler.
      errorResponseBuilder: (_request, context) => AppErrors.rateLimited(Math.ceil(context.ttl / 1000)),
    });
  },
  { name: 'rate-limit', dependencies: ['config', 'redis'] },
);
