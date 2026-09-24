/*
 * redact.ts — strips secret-looking substrings out of free text before it
 * goes into a diagnostics report (main/diagnostics.ts, lib/diagnostics.ts).
 *
 * The report is built to carry no values in the first place: key names and
 * types, the adapter's counters, and log lines the adapter writes itself.
 * This is the second layer, for the one place outside text can get in: an
 * error message thrown by EA's own code and logged by the adapter, which
 * could quote a session id, an email or a coin balance. Deliberately
 * greedy: a diagnostics line that loses a trade id to `[redacted]` costs
 * nothing, a leaked session token costs a lot.
 *
 * Zod-free and chrome-free: it runs in the MAIN-world adapter too.
 */

const REDACTED = '[redacted]';

// Order matters: the specific shapes first, so a JWT is not half-eaten by
// the generic long-token rule and left with a readable tail.
const PATTERNS: RegExp[] = [
  // email addresses
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  // JWTs and other dot-separated base64url tokens
  /eyJ[\w-]*(?:\.[\w-]*)*/g,
  // UUIDs (session ids, persona ids)
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // any other long run of token characters with a digit in it (so a long
  // camelCase method name, which diagnostics exist to report, survives)
  /(?=[A-Za-z_+=-]*\d)[A-Za-z0-9_+=-]{24,}/g,
  // long numbers: coin balances, account and persona ids
  /\d{6,}/g,
];

/** `text` with every secret-looking substring replaced by `[redacted]`. */
export function scrubText(text: string): string {
  let out = String(text);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** True when a property *name* looks like data rather than code — an
 * object keyed by email, id or token. Such names are not reported. */
export function isSecretLookingKey(key: string): boolean {
  return scrubText(key) !== key;
}
