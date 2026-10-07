import { randomInt } from 'node:crypto';

import { authenticator } from 'otplib';

authenticator.options = { window: 1 }; // accept one step of clock drift either side

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpKeyUri(secret: string, email: string, issuer = 'Nova Trade'): string {
  return authenticator.keyuri(email, issuer, secret);
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.check(code, secret);
  } catch {
    return false;
  }
}

// Crockford base32 minus the ambiguous I/L/O/U — 32 symbols, so each draw is
// exactly 5 bits of entropy with no bias.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 human-typeable recovery codes (XXXX-XXXX format) — plaintext returned
 * once, only argon2 hashes are persisted. Each of the 8 characters is an
 * independent uniform draw from a 32-symbol alphabet (40 bits/code) via
 * `crypto.randomInt`. The earlier version derived from `randomToken(5)` then
 * stripped non-alphanumerics, upper-cased (collapsing base64url's case) and
 * 0-padded short draws, which left usable entropy well under 8 characters. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = '';
    for (let c = 0; c < 8; c++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}
