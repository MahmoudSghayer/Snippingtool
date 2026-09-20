// CSRF double-submit protection, for the dashboard's cookie-session flow
// only — the extension always uses a bearer Authorization header, which is
// immune to CSRF by construction (a cross-site form/script cannot set a
// custom Authorization header), so bearer-authenticated requests never need
// the CSRF token and this plugin's check is skipped for them (see
// `authenticate` in plugins/auth.ts, which tags `request.authMethod`).
//
// Deliberately NOT `@fastify/csrf-protection`'s own secret+derived-token
// model: that library stores a *secret* in the cookie and expects the
// client to send a separately-*derived* token (via `tokens.create(secret)`)
// in the header — which requires an endpoint that hands the derived token
// to the client, since the client cannot compute it from the cookie alone.
// The dashboard's already-shipped client (apps/dashboard/src/api/client.ts,
// `readCsrfCookie()`) implements the simpler, standard "naive" double-submit
// pattern instead: it reads the `sl_csrf` cookie's raw value straight out of
// `document.cookie` and echoes that *same* value back as `x-csrf-token` —
// no token-issuance endpoint exists or is needed. This plugin's contract
// (docs/04-auth.md §10: "the cookie ... must match the header") matches
// that shipped client: verification is a literal, constant-time comparison
// of the raw `sl_csrf` cookie value against the `x-csrf-token` header, not
// `@fastify/csrf-protection`'s HMAC-derived-token check (which this file
// used to call and which can never pass against a client that echoes the
// cookie verbatim — see tests/security/src/csrf.test.ts's "accepts a
// cookie-session mutation with the correct x-csrf-token" case).
//
// The cookie value itself is still an unguessable random token, and it is
// still cookie-*signed* (`@fastify/cookie`, `COOKIE_SECRET`) so a literal
// string match alone isn't the only thing standing between an attacker and
// a forged pair: an attacker who can plant an *unsigned* `sl_csrf` cookie
// from a sibling subdomain (cookie tossing) and mirror it into the header
// from that same subdomain still can't produce a value that verifies as
// validly signed without knowing `COOKIE_SECRET`, so `verifyCsrf` rejects
// it even though the raw strings match each other.
//
// Usage: a route that mutates state under a cookie session adds
// `{ preHandler: [fastify.verifyCsrf] }` alongside `fastify.authenticate`.
// GET/HEAD/OPTIONS reads never need it — only wire it onto mutations.

import { randomBytes, timingSafeEqual } from 'node:crypto';

import fp from 'fastify-plugin';

import { AppErrors } from '../lib/errors.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    verifyCsrf: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void;
  }
}

const CSRF_COOKIE = 'sl_csrf';

/** Reads a cookie's raw (still percent-encoded, still `value.signature`)
 * value straight out of the `Cookie` request header, bypassing
 * `request.cookies` (which `@fastify/cookie` URI-decodes). The comparison
 * in `verifyCsrf` below must be byte-for-byte against what the browser's
 * `document.cookie` exposes to the dashboard's JS (see this file's header
 * comment) — `@fastify/cookie`'s decoding step is exactly the kind of
 * transformation that would make an otherwise-matching pair look different,
 * so both sides of the comparison read the header text directly instead. */
function readRawCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export default fp(
  async function csrfPlugin(fastify: FastifyInstance) {
    // Issuance: every non-bearer request that doesn't already carry a
    // validly-signed sl_csrf cookie gets a fresh one minted, so the cookie
    // exists from the dashboard's very first page load (any GET) — a
    // browser that only ever calls `GET /users/me` before its first
    // mutation still has a valid `sl_csrf` cookie in hand by the time it
    // needs one. A no-op on every request after the first for a given
    // client, since the existing cookie is still validly signed.
    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers.authorization) return; // bearer clients never need this cookie
      const raw = readRawCookie(request.headers.cookie, CSRF_COOKIE);
      if (raw && fastify.unsignCookie(decodeURIComponent(raw)).valid) return;
      const token = randomBytes(32).toString('base64url');
      reply.setCookie(CSRF_COOKIE, token, { signed: true, httpOnly: false, sameSite: 'lax', path: '/' });
    });

    // Kept as a (request, reply, done) callback (rather than async) purely
    // so it composes as a `preHandler` alongside other callback-style hooks
    // in this codebase without extra wrapping; `done(error)` routes through
    // `plugins/error-handler.ts` exactly like a thrown AppError would.
    fastify.decorate(
      'verifyCsrf',
      function verifyCsrf(request: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) {
        if (request.headers.authorization) {
          done();
          return;
        }

        const rawCookie = readRawCookie(request.headers.cookie, CSRF_COOKIE);
        const header = request.headers['x-csrf-token'];

        if (!rawCookie || typeof header !== 'string' || header.length === 0) {
          done(AppErrors.forbidden('Missing CSRF token.'));
          return;
        }

        const decodedCookie = decodeURIComponent(rawCookie);
        if (!fastify.unsignCookie(decodedCookie).valid) {
          done(AppErrors.forbidden('Invalid CSRF token.'));
          return;
        }

        // Literal double-submit match — accept either the raw (still
        // percent-encoded) or decoded form of both sides, since the
        // dashboard's client copies `document.cookie` verbatim into the
        // header without normalising encoding either way.
        const matches = safeEqual(rawCookie, header) || safeEqual(decodedCookie, decodeURIComponent(header));
        if (!matches) {
          done(AppErrors.forbidden('Invalid CSRF token.'));
          return;
        }

        done();
      },
    );
  },
  { name: 'csrf', dependencies: ['config', 'cookie'] },
);
