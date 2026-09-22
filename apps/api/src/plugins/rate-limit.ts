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
      // Per-IP AND per-user (docs/09-security.md "Rate limiting"): keyed by
      // IP alone, one abusive account behind a shared/NAT'd IP (an office,
      // a mobile carrier) would also throttle every *other* account on that
      // IP; keyed by user alone, an attacker rotating source IPs against
      // one account would never trip it. Combining both closes each gap
      // without opening the other — an authenticated request is keyed by
      // `ip:userId` (still per-IP-scoped, so one compromised account can't
      // exhaust the budget for every IP it's ever used from), an
      // unauthenticated request falls back to `ip` alone (nothing else to
      // key by yet — that's what the auth module's own tighter per-route
      // tier + Redis sliding window + DB lockout are for, see
      // `modules/auth/service.ts`). Never throws: a malformed/expired token
      // here just means "unauthenticated for rate-limit purposes", the real
      // 401 comes from `fastify.authenticate` on routes that require it.
      keyGenerator: (request) => {
        const auth = request.headers.authorization;
        const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
        const cookieToken = (request.cookies as Record<string, string | undefined> | undefined)
          ?.sl_at;
        const token = bearer ?? cookieToken;
        if (!token) return request.ip;
        try {
          const payload = token.split('.')[1];
          if (!payload) return request.ip;
          const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
            sub?: unknown;
          };
          return typeof claims.sub === 'string' && claims.sub.length > 0
            ? `${request.ip}:${claims.sub}`
            : request.ip;
        } catch {
          return request.ip;
        }
      },
      // @fastify/rate-limit `throw`s whatever this returns (see its
      // source — not a `reply.send()`), so returning the AppError instance
      // itself means it lands in plugins/error-handler.ts's `isAppError`
      // branch with the correct status/code/message/details, exactly like
      // an AppError thrown from a route handler.
      errorResponseBuilder: (_request, context) =>
        AppErrors.rateLimited(Math.ceil(context.ttl / 1000)),
    });
  },
  { name: 'rate-limit', dependencies: ['config', 'redis'] },
);
