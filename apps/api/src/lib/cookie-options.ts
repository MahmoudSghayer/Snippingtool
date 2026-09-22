// Shared cookie-attribute resolution for every cookie this API sets
// (session `sl_at`/`sl_rt` in modules/auth/index.ts, CSRF `sl_csrf` in
// plugins/csrf.ts) — docs/09-security.md open finding #1 ("Cross-site
// cookie SameSite for the Vercel-hosted dashboard").
//
// `COOKIE_SAME_SITE` (config/env.ts) picks the attribute; `secure` is
// derived, never independently configurable to 'lax'/'none' mismatches:
// - `sameSite: 'none'` is rejected outright by browsers without `Secure`,
//   so `secure` is forced true whenever COOKIE_SAME_SITE is 'none',
//   regardless of NODE_ENV (a non-prod HTTPS preview/staging deploy still
//   needs it).
// - Otherwise `secure` follows `isProd || COOKIE_SECURE` as before.

import type { Env } from '../config/env.js';
import type { CookieSerializeOptions } from '@fastify/cookie';

export interface ResolvedCookieAttrs {
  sameSite: NonNullable<CookieSerializeOptions['sameSite']>;
  secure: boolean;
}

export function resolveCookieAttrs(
  config: Pick<Env, 'NODE_ENV' | 'COOKIE_SAME_SITE' | 'COOKIE_SECURE'>,
): ResolvedCookieAttrs {
  const isProd = config.NODE_ENV === 'production';
  const sameSite = config.COOKIE_SAME_SITE;
  const secure = sameSite === 'none' ? true : isProd || config.COOKIE_SECURE;
  return { sameSite, secure };
}
