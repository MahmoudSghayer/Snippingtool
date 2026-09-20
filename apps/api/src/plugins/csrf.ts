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

    // Token issuance (the other half of double-submit): `@fastify/csrf-
    // protection` only *decorates* `reply.generateCsrf()` — nothing calls it
    // on its own, and this app never did either, which meant the `sl_csrf`
    // cookie the dashboard's own API client already reads
    // (docs/07-dashboard.md §4, "the exact double-submit contract
    // docs/04-auth.md §10 describes") was never actually issued by the
    // server: every cookie-session mutation would 403 with "Missing csrf
    // secret" on a browser that had never separately been handed the
    // cookie some other way. Fixed here, once, for every non-bearer
    // request rather than only on login, so the cookie exists from the
    // dashboard's very first page load (any GET) — a browser that only
    // ever calls `GET /users/me` before its first mutation still has a
    // valid `sl_csrf` cookie in hand by the time it needs one.
    // `generateCsrf()` reuses the existing secret (and does not re-set the
    // cookie) when the request already carries a valid one — see
    // `@fastify/csrf-protection`'s own `generateCsrfCookie`, so this is a
    // no-op on every request after the first for a given client.
    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers.authorization) return; // bearer clients never need this cookie
      reply.generateCsrf();
    });
  },
  { name: 'csrf', dependencies: ['config', 'cookie'] },
);
