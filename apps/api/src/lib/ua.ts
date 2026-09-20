// Coarse User-Agent "family" extraction — used only to bind a refresh token
// to the browser family it was issued to (docs/09-security.md "Session
// security"). Deliberately not a full UA parser: this only needs to tell
// "Chrome" from "Firefox" from "curl", not track exact versions (which
// legitimately change across a session's lifetime and would make this a
// false-positive machine if compared exactly).

const FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/edg\//i, 'edge'],
  [/opr\//i, 'opera'],
  [/chrome\//i, 'chrome'],
  [/crios\//i, 'chrome-ios'],
  [/fxios\//i, 'firefox-ios'],
  [/firefox\//i, 'firefox'],
  [/version\/.*safari/i, 'safari'],
  [/safari\//i, 'safari'],
  [/msie|trident/i, 'ie'],
];

/** Returns a coarse browser-family token for a User-Agent string, or `null`
 * if the string is empty/unrecognised (never throws). */
export function uaFamily(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(userAgent)) return family;
  }
  return 'other';
}

/** True when two User-Agent strings should be treated as "the same
 * install's browser" for refresh-token binding purposes. Either side being
 * empty/unrecognised means there is no baseline to compare against, so this
 * returns true (nothing to contradict) rather than false (which would lock
 * out every client that legitimately never sends a User-Agent, e.g. some
 * service-worker fetches). */
export function uaFamiliesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const famA = uaFamily(a);
  const famB = uaFamily(b);
  if (!famA || !famB) return true;
  return famA === famB;
}
