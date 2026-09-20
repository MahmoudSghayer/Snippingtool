import { describe, expect, it } from 'vitest';

import { decryptTotpSecret, encryptTotpSecret, fastHash, generateLicenseKey, hashSecret, randomToken, timingSafeEqualString, verifySecret } from '../crypto.js';

describe('crypto helpers', () => {
  it('hashSecret/verifySecret round-trips and rejects a wrong secret', async () => {
    const hash = await hashSecret('correct-horse-battery-staple');
    expect(await verifySecret(hash, 'correct-horse-battery-staple')).toBe(true);
    expect(await verifySecret(hash, 'wrong-secret')).toBe(false);
  });

  it('verifySecret never throws on a malformed hash', async () => {
    await expect(verifySecret('not-a-real-hash', 'anything')).resolves.toBe(false);
  });

  it('randomToken produces distinct, URL-safe values of roughly the requested entropy', () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(32);
  });

  it('fastHash is deterministic and collision-resistant across distinct inputs', () => {
    expect(fastHash('same')).toBe(fastHash('same'));
    expect(fastHash('a')).not.toBe(fastHash('b'));
  });

  it('timingSafeEqualString compares correctly regardless of length', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
  });

  it('generateLicenseKey produces the SL-XXXX-XXXX-XXXX-XXXX shape with a matching prefix', () => {
    const { key, prefix } = generateLicenseKey();
    expect(key).toMatch(/^SL-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix).toMatch(/^SL-[0-9A-Z]{4}$/);
  });

  it('encryptTotpSecret/decryptTotpSecret round-trips and fails under a different key', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const blob = encryptTotpSecret(secret, 'cookie-secret-one');
    expect(decryptTotpSecret(blob, 'cookie-secret-one')).toBe(secret);
    expect(() => decryptTotpSecret(blob, 'cookie-secret-two')).toThrow();
  });
});
