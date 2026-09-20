// Token/password hashing helpers used across auth, devices, and anywhere else
// a secret needs to be hashed-at-rest and compared safely.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import argon2 from 'argon2';

const ARGON2_OPTS = { type: argon2.argon2id } as const;

/** Hashes a password or any opaque secret (verification tokens, recovery
 * codes, refresh tokens) with argon2id. */
export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, ARGON2_OPTS);
}

/** Verifies a plaintext secret against an argon2id hash. Never throws on a
 * mismatch — returns false. */
export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

/** Generates a URL-safe opaque token (used for refresh tokens, email
 * verification, password reset, recovery codes) of `bytes` random bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Fast, non-secret-hash lookup key for a token: SHA-256, hex. Used so we can
 * index by hash in Postgres for exact-match lookups (email verification,
 * password reset, refresh tokens) *in addition to* the slow argon2 hash
 * stored for verification — see docs/04-auth.md, "token storage". Most
 * single-use tokens use this fast hash directly as `token_hash` since they
 * are high-entropy random values already (no brute-force benefit to argon2
 * here); this keeps lookups O(1) via a unique index instead of scanning to
 * argon2-verify every unexpired row. */
export function fastHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison for anything compared outside a DB unique
 * index (e.g. CSRF double-submit tokens). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Generates a human-readable license key: SL-XXXX-XXXX-XXXX-XXXX using
 * Crockford base32 (no I/L/O/U to avoid confusion), plus a mod-37 checksum
 * character appended to the last group so a typo is detectable client-side
 * before ever hitting the server. Exposed here (rather than only in the
 * subscriptions module) since it is a pure crypto/formatting helper other
 * modules (e.g. admin license lookup by prefix) may also need. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateLicenseKey(): { key: string; prefix: string } {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    const bytes = randomBytes(4);
    for (let i = 0; i < 4; i++) {
      group += CROCKFORD_ALPHABET[(bytes[i] ?? 0) % CROCKFORD_ALPHABET.length];
    }
    groups.push(group);
  }
  const key = `SL-${groups.join('-')}`;
  const prefix = `SL-${groups[0]}`;
  return { key, prefix };
}
