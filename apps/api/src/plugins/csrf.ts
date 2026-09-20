// CSRF double-submit protection, for the dashboard's cookie-session flow
// only — the extension always uses a bearer Authorization header, which is
// immune to CSRF by construction (a cross-site form/script cannot set a
// custom Authorization header), so bearer-authenticated requests never need
// the CSRF token and this plugin's check is skipped for them (see
// `authenticate` in plugins/auth.ts, which tags `request.authMethod`).
//
// Usage: a route that mutates state under a cookie session adds
// `{ onRequest: [fastify.csrfProtection] }`, or the module registers it as a
// blanket preHandler for its whole prefix. GET/HEAD/OPTIONS are exempt by
// the plugin itself.

import csrfProtection from '@fastify/csrf-protection';
import fp from 'fastify-plugin';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    verifyCsrf: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void;
  }
}

export default fp(
  async function csrfPlugin(fastify: FastifyInstance) {
    await fastify.register(csrfProtection, {
      cookieOpts: { signed: true, httpOnly: false, sameSite: 'lax', path: '/' },
      cookieKey: 'sl_csrf',
      sessionPlugin: '@fastify/cookie',
      getToken: (request) => (request.headers['x-csrf-token'] as string | undefined) ?? undefined,
    });

    // Skip CSRF entirely for bearer-authenticated (extension) requests — the
    // Authorization header cannot be set by a cross-site form/script, so
    // bearer calls are immune to CSRF by construction. Routes that mutate
    // state under a cookie session add `{ preHandler: fastify.verifyCsrf }`.
    // Kept as a (request, reply, done) callback — matching
    // `fastify.csrfProtection`'s own signature — so Fastify's hook system
    // treats it as callback-style and correctly short-circuits when
    // csrfProtection calls `reply.send(error)` without calling `done()`.
    fastify.decorate(
      'verifyCsrf',
      function verifyCsrf(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
        if (request.headers.authorization) {
          done();
          return;
        }
        fastify.csrfProtection(request, reply, done);
      },
    );
  },
  { name: 'csrf', dependencies: ['config', 'cookie'] },
);
