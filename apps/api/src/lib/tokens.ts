// Access/refresh token issuance and verification.
//
// Access token: EdDSA-signed JWT, 15 min, claims { sub, sid, did, role, plan,
// ver }. `ver` mirrors the user's `row_version` at issue time — force logout
// / password change / any account-affecting admin write bumps row_version
// (via the DB's bump_row_version trigger, which fires on any UPDATE), so a
// previously issued access token with a stale `ver` is rejected even before
// its 15-minute expiry (see `verifyAccessToken`'s caller in plugins/auth.ts,
// which re-checks `ver` against the current DB row).
//
// Refresh token: opaque 32 random bytes, never a JWT. Only its SHA-256 hash
// is stored (`sessions.refresh_token_hash`). Rotation: every refresh issues a
// new opaque token and updates the row in place; if a refresh token is
// presented that does NOT match the current hash for its family but the
// family is still valid, that is reuse of a superseded token — the entire
// family is revoked (docs/04-auth.md, "refresh rotation & reuse detection").

import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';

import { fastHash, randomToken } from './crypto.js';
import { newId } from './ids.js';

export interface AccessTokenClaims {
  sub: string; // userId
  sid: string; // sessionId
  did: string | null; // deviceId
  role: 'user' | 'admin';
  plan: string | null;
  ver: number;
}

const ACCESS_TOKEN_TTL_USER = '15m';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
// Shorter admin TTL (docs/09-security.md "Session security"): an admin
// access token is worth more than a plain user's (it can reach every
// `requirePermission`-gated route), so it re-verifies against the DB
// (role/row_version, via `authenticate`) more often. 5 minutes still comes
// back automatically via the same silent-refresh flow the dashboard already
// uses for user sessions — this only shrinks the compromised-token window,
// it does not change how often an admin has to re-enter a password or TOTP
// code (that stays governed by the refresh token's own 30-day TTL).
const ACCESS_TOKEN_TTL_ADMIN = '5m';
export const ADMIN_ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MFA_TICKET_TTL_SECONDS = 5 * 60;

/** The access-token lifetime for a given role — `signAccessToken` uses this
 * internally (keyed off `claims.role`); callers that need to report
 * `expiresIn` in a login/refresh response use this directly so the number
 * they return always matches what was actually signed. */
export function accessTokenTtlSeconds(role: AccessTokenClaims['role']): number {
  return role === 'admin' ? ADMIN_ACCESS_TOKEN_TTL_SECONDS : ACCESS_TOKEN_TTL_SECONDS;
}

type JoseKey = Awaited<ReturnType<typeof importPKCS8>>;

// Keyed by the PEM string itself (not a single global slot) — in production
// there is exactly one JWT_PRIVATE_KEY/PUBLIC_KEY per process, so this cache
// never grows past one entry each, but keying by value (rather than
// memoising unconditionally on first call) keeps this correct for anything
// that legitimately verifies against more than one key value, e.g. tests
// and any future key-rotation support.
const privateKeyCache = new Map<string, Promise<JoseKey>>();
const publicKeyCache = new Map<string, Promise<JoseKey>>();

function getPrivateKey(pem: string) {
  let cached = privateKeyCache.get(pem);
  if (!cached) {
    cached = importPKCS8(pem, 'EdDSA');
    privateKeyCache.set(pem, cached);
  }
  return cached;
}

function getPublicKey(pem: string) {
  let cached = publicKeyCache.get(pem);
  if (!cached) {
    cached = importSPKI(pem, 'EdDSA');
    publicKeyCache.set(pem, cached);
  }
  return cached;
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  privateKeyPem: string,
): Promise<string> {
  const key = await getPrivateKey(privateKeyPem);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(claims.role === 'admin' ? ACCESS_TOKEN_TTL_ADMIN : ACCESS_TOKEN_TTL_USER)
    .sign(key);
}

export async function verifyAccessToken(
  token: string,
  publicKeyPem: string,
): Promise<AccessTokenClaims> {
  const key = await getPublicKey(publicKeyPem);
  const { payload } = await jwtVerify(token, key);
  return payload as unknown as AccessTokenClaims;
}

/** A short-lived (5 min), single-use MFA step-up ticket, issued in place of
 * tokens by `/auth/login` when the account has TOTP enabled. Not a JWT (kept
 * opaque + Redis-backed with the pending login context) so it can be
 * invalidated after one use without needing a denylist. */
export function generateMfaTicket(): string {
  return randomToken(24);
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: fastHash(token) };
}

/** `sessions.family_id` is a `uuid` column — a uuidv7, not an opaque token. */
export function generateFamilyId(): string {
  return newId();
}
