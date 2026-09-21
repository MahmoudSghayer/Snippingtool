// @fastify/helmet: CSP, HSTS, X-Content-Type-Options: nosniff, X-Frame-Options
// DENY, etc. The API serves JSON only (no HTML views), so CSP is locked down
// to 'none' by default. See docs/09-security.md "Secure headers" for the
// full inventory + `tests/security` for the header assertions.

import helmet from '@fastify/helmet';
import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

// No browser feature this JSON API's own responses could ever need — every
// Permissions-Policy feature is denied outright (`()` = nobody, not even
// same-origin). Helmet doesn't ship a Permissions-Policy middleware (the
// header's syntax is still evolving upstream), so it's set directly here
// rather than pulling in a second dependency for one static header.
const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()';

export default fp(
  async function securityPlugin(fastify: FastifyInstance) {
    const isProd = fastify.config.NODE_ENV === 'production';

    await fastify.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      // X-Frame-Options: DENY (helmet's own default is SAMEORIGIN) — this
      // JSON API has no "same origin" that should ever frame it either;
      // `contentSecurityPolicy.frameAncestors: 'none'` above is the modern
      // equivalent and takes precedence in any browser that honours CSP,
      // this is the legacy fallback for the (now rare) ones that don't.
      frameguard: { action: 'deny' },
      // `no-referrer` (helmet's own default, restated here so it's an
      // explicit decision, not an implicit one a future helmet major could
      // silently change) — this API never wants the caller's prior URL,
      // and never wants to leak its own URLs (which can carry
      // request-identifying query params) to a third party via the
      // Referer header on an outbound link either.
      referrerPolicy: { policy: 'no-referrer' },
      // HSTS preload (docs/09-security.md "Encryption in transit"): only
      // meaningful once this origin is actually submitted to the browser
      // preload list, which is an operational step outside this repo, but
      // the header itself is safe to ship now — preload is opt-in per
      // origin, this flag just makes the origin *eligible*. Dev/test never
      // sends HSTS at all (no TLS locally, and a stray HSTS header from a
      // local dev run must never get cached by a browser against
      // localhost).
      hsts: isProd ? { maxAge: 15552000, includeSubDomains: true, preload: true } : false,
    });

    // See PERMISSIONS_POLICY above.
    fastify.addHook('onSend', (_request, reply, payload, done) => {
      reply.header('Permissions-Policy', PERMISSIONS_POLICY);
      done(null, payload);
    });
  },
  { name: 'security', dependencies: ['config'] },
);
