// The per-user token in the userscript's download URL.
//
// Tampermonkey fetches a script's @downloadURL and @updateURL itself,
// without the user's cookies or bearer token, so the download is gated by a
// signed URL instead: `<userId>.<HMAC-SHA256(userId)>`. The HMAC key is
// derived from COOKIE_SECRET with a purpose string, so it is never the
// cookie-signing key itself, and nothing is stored: the API recomputes the
// signature on every request. The URL identifies the user; whether it
// serves anything depends on that user's pass at the time of the request
// (modules/downloads), so updates stop when the pass lapses.

import { createHmac, timingSafeEqual } from 'node:crypto';

const PURPOSE = 'userscript-download:v1';

function key(secret: string): Buffer {
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

function signature(userId: string, secret: string): string {
  return createHmac('sha256', key(secret)).update(userId).digest('base64url');
}

export function signUserscriptToken(userId: string, secret: string): string {
  return `${userId}.${signature(userId, secret)}`;
}

/** The user id the token was issued for, or null when it is malformed or
 * its signature does not match. */
export function verifyUserscriptToken(token: string, secret: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signature(userId, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return userId;
}
