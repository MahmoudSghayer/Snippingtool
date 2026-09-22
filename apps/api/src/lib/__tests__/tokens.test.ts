import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { describe, expect, it, beforeAll } from 'vitest';

import {
  generateFamilyId,
  generateRefreshToken,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from '../tokens.js';

describe('token helpers', () => {
  let privateKeyPem: string;
  let publicKeyPem: string;

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true,
    });
    privateKeyPem = await exportPKCS8(privateKey);
    publicKeyPem = await exportSPKI(publicKey);
  });

  it('signs and verifies an access token, round-tripping every claim', async () => {
    const claims: AccessTokenClaims = {
      sub: 'user-1',
      sid: 'session-1',
      did: 'device-1',
      role: 'user',
      plan: 'pro',
      ver: 3,
    };
    const token = await signAccessToken(claims, privateKeyPem);
    const decoded = await verifyAccessToken(token, publicKeyPem);
    expect(decoded.sub).toBe('user-1');
    expect(decoded.sid).toBe('session-1');
    expect(decoded.did).toBe('device-1');
    expect(decoded.role).toBe('user');
    expect(decoded.plan).toBe('pro');
    expect(decoded.ver).toBe(3);
  });

  it('rejects a token signed by a different key', async () => {
    const { privateKey: otherPrivate } = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true,
    });
    const otherPem = await exportPKCS8(otherPrivate);
    const claims: AccessTokenClaims = {
      sub: 'user-1',
      sid: 's',
      did: null,
      role: 'user',
      plan: null,
      ver: 0,
    };
    const token = await signAccessToken(claims, otherPem);
    await expect(verifyAccessToken(token, publicKeyPem)).rejects.toThrow();
  });

  it('generateRefreshToken returns a token whose hash is derivable but the token itself is not the hash', () => {
    const { token, hash } = generateRefreshToken();
    expect(token).not.toBe(hash);
    expect(token.length).toBeGreaterThan(20);
    expect(hash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
  });

  it('generateFamilyId returns a valid uuid (sessions.family_id is a uuid column)', () => {
    const id = generateFamilyId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
