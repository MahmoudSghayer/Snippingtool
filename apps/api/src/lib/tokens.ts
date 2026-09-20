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

export interface AccessTokenClaims {
  sub: string; // userId
  sid: string; // sessionId
  did: string | null; // deviceId
  role: 'user' | 'admin';
  plan: string | null;
  ver: number;
}

const ACCESS_TOKEN_TTL = '15m';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MFA_TICKET_TTL_SECONDS = 5 * 60;

type JoseKey = Awaited<ReturnType<typeof importPKCS8>>;

let cachedPrivateKey: Promise<JoseKey> | undefined;
let cachedPublicKey: Promise<JoseKey> | undefined;

function getPrivateKey(pem: string) {
  cachedPrivateKey ??= importPKCS8(pem, 'EdDSA');
  return cachedPrivateKey;
}

function getPublicKey(pem: string) {
  cachedPublicKey ??= importSPKI(pem, 'EdDSA');
  return cachedPublicKey;
}

export async function signAccessToken(claims: AccessTokenClaims, privateKeyPem: string): Promise<string> {
  const key = await getPrivateKey(privateKeyPem);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(key);
}

export async function verifyAccessToken(token: string, publicKeyPem: string): Promise<AccessTokenClaims> {
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

export function generateFamilyId(): string {
  return randomToken(16);
}
