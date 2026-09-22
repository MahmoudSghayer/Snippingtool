// Token/password hashing helpers used across auth, devices, and anywhere else
// a secret needs to be hashed-at-rest and compared safely.

import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';

import argon2 from 'argon2';

const ARGON2_OPTS = { type: argon2.argon2id } as const;

// --- TOTP secret at-rest encryption -----------------------------------
// AES-256-GCM, application-layer (not pgcrypto) so it works identically in
// tests against a plain Postgres role with no extra setup.
//
// Key-id versioning (docs/09-security.md "Encryption at rest"): every
// ciphertext blob embeds the id of the key it was encrypted under, so a key
// can be rotated without a flag day — new writes use the current active
// key, old rows keep decrypting under whichever key id they were written
// with, and `reencryptTotpSecret` migrates a row onto the active key the
// next time it's touched. The default registry has exactly one entry,
// `'v1'`, derived from COOKIE_SECRET (already a required, secret env var)
// via SHA-256 with a fixed, purpose-specific salt string — deliberately not
// reusing COOKIE_SECRET's raw bytes directly for a different purpose. A
// real rotation adds a new id to the registry and repoints the active id at
// it (see `getTotpKeyRegistry` below) rather than replacing COOKIE_SECRET
// in place, which would make every already-encrypted row unreadable.
//
// `TOTP_ENCRYPTION_KEYS`/`TOTP_ENCRYPTION_ACTIVE_KEY_ID` are read directly
// from `process.env` (not `config/env.ts`) for the same cross-agent-
// ownership reason `lib/geoip.ts` documents: additive, optional, and the
// exact schema fields to add to `config/env.ts` formally are written up in
// docs/09-security.md "Open findings".
export interface TotpKeyEntry {
  id: string;
  material: string;
}

/** `[{ id: 'v1', material: cookieSecret }, ...anything from TOTP_ENCRYPTION_KEYS]`.
 * `TOTP_ENCRYPTION_KEYS` is JSON, `{"v2": "<key material>", ...}` — additive
 * key versions for rotation; `'v1'` is always derived from `cookieSecret`
 * regardless of what (if anything) that env var also defines for `'v1'`. */
function getTotpKeyRegistry(cookieSecret: string): TotpKeyEntry[] {
  const registry: TotpKeyEntry[] = [{ id: 'v1', material: cookieSecret }];
  const raw = process.env.TOTP_ENCRYPTION_KEYS;
  if (raw) {
    try {
      const extra = JSON.parse(raw) as Record<string, string>;
      for (const [id, material] of Object.entries(extra)) {
        if (id === 'v1' || typeof material !== 'string' || material.length === 0) continue;
        registry.push({ id, material });
      }
    } catch {
      // Malformed env value: fall back to just 'v1' rather than throwing at
      // encrypt/decrypt time over an operator typo.
    }
  }
  return registry;
}

function activeTotpKeyId(): string {
  return process.env.TOTP_ENCRYPTION_ACTIVE_KEY_ID || 'v1';
}

function deriveTotpKey(material: string): Buffer {
  return createHash('sha256').update(`totp-secret-encryption:${material}`).digest();
}

/** Encrypts a base32 TOTP secret for storage in `users.totp_secret_enc`
 * (bytea): `[1-byte key-id length][key-id ascii][12-byte random IV]
 * [ciphertext][16-byte auth tag]`, concatenated. Always encrypts under the
 * *active* key id (`TOTP_ENCRYPTION_ACTIVE_KEY_ID`, default `'v1'`). */
export function encryptTotpSecret(secret: string, cookieSecret: string): Buffer {
  const registry = getTotpKeyRegistry(cookieSecret);
  const keyId = activeTotpKeyId();
  const entry = registry.find((k) => k.id === keyId);
  if (!entry) {
    throw new Error(
      `encryptTotpSecret: active key id "${keyId}" is not in the key registry (checked TOTP_ENCRYPTION_KEYS).`,
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveTotpKey(entry.material), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const idBuf = Buffer.from(entry.id, 'ascii');
  if (idBuf.length > 255) throw new Error('encryptTotpSecret: key id too long (max 255 bytes).');
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, iv, ciphertext, tag]);
}

/** Decrypts a blob written by `encryptTotpSecret` — looks up whichever key
 * id the blob itself names in the registry, so a row written under an
 * older key id keeps decrypting after the active id moves on (as long as
 * that older id's material is still listed in `TOTP_ENCRYPTION_KEYS`, which
 * is exactly what makes rotation possible without a flag day — see
 * `reencryptTotpSecret`). */
export function decryptTotpSecret(blob: Buffer, cookieSecret: string): string {
  const idLen = blob[0];
  if (idLen === undefined || blob.length < 1 + idLen + 12 + 16) {
    throw new Error('decryptTotpSecret: malformed blob.');
  }
  const keyId = blob.subarray(1, 1 + idLen).toString('ascii');
  const rest = blob.subarray(1 + idLen);
  const iv = rest.subarray(0, 12);
  const tag = rest.subarray(rest.length - 16);
  const ciphertext = rest.subarray(12, rest.length - 16);

  const registry = getTotpKeyRegistry(cookieSecret);
  const entry = registry.find((k) => k.id === keyId);
  if (!entry)
    throw new Error(
      `decryptTotpSecret: unknown key id "${keyId}" — is it still listed in TOTP_ENCRYPTION_KEYS?`,
    );

  const decipher = createDecipheriv('aes-256-gcm', deriveTotpKey(entry.material), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Key-rotation helper: decrypts `blob` (under whichever key id it was
 * written with) and re-encrypts it under the *current* active key id.
 * Returns the same bytes unchanged if it's already on the active key — so
 * calling this unconditionally on every read-modify-write of a TOTP secret
 * is always safe, and is how a rotation actually completes in practice:
 * each row migrates the next time it's touched, rather than a bulk
 * migration job needing to run before the old key id can be retired. See
 * docs/09-security.md "Key rotation" for the operational runbook (add the
 * new id to `TOTP_ENCRYPTION_KEYS`, flip `TOTP_ENCRYPTION_ACTIVE_KEY_ID`,
 * keep the old id in the registry until every row has been touched at
 * least once, then remove it). */
export function reencryptTotpSecret(blob: Buffer, cookieSecret: string): Buffer {
  const idLen = blob[0];
  if (idLen !== undefined && blob.subarray(1, 1 + idLen).toString('ascii') === activeTotpKeyId()) {
    return blob; // already on the active key — nothing to do
  }
  const secret = decryptTotpSecret(blob, cookieSecret);
  return encryptTotpSecret(secret, cookieSecret);
}

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
