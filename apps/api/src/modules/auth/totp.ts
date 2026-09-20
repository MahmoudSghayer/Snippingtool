import { authenticator } from 'otplib';

import { randomToken } from '../../lib/crypto.js';

authenticator.options = { window: 1 }; // accept one step of clock drift either side

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpKeyUri(secret: string, email: string, issuer = "The Sniper's Ledger"): string {
  return authenticator.keyuri(email, issuer, secret);
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.check(code, secret);
  } catch {
    return false;
  }
}

/** 10 human-typeable recovery codes (XXXX-XXXX format, base32-ish alphabet
 * via base64url then reformatted) — plaintext returned once, only argon2
 * hashes are persisted. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomToken(5).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8).padEnd(8, '0');
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}
