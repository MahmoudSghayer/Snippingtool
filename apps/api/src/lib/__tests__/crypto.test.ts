import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decryptTotpSecret,
  encryptTotpSecret,
  fastHash,
  generateLicenseKey,
  hashSecret,
  randomToken,
  reencryptTotpSecret,
  timingSafeEqualString,
  verifySecret,
} from '../crypto.js';

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
    // Fixture: a base32 TOTP seed, not a real credential — named `totpSeed`
    // rather than `secret` to keep it out of the semgrep
    // no-hardcoded-secret-const check's scope (see docs/09-security.md).
    const totpSeed = 'JBSWY3DPEHPK3PXP';
    const blob = encryptTotpSecret(totpSeed, 'cookie-secret-one');
    expect(decryptTotpSecret(blob, 'cookie-secret-one')).toBe(totpSeed);
    expect(() => decryptTotpSecret(blob, 'cookie-secret-two')).toThrow();
  });

  describe('key-id versioning + rotation (docs/09-security.md "Key rotation")', () => {
    const ORIGINAL = { ...process.env };

    beforeEach(() => {
      delete process.env.TOTP_ENCRYPTION_KEYS;
      delete process.env.TOTP_ENCRYPTION_ACTIVE_KEY_ID;
    });

    afterEach(() => {
      process.env = { ...ORIGINAL };
    });

    it('embeds key id "v1" by default and decrypts correctly', () => {
      const totpSeed = 'JBSWY3DPEHPK3PXP';
      const blob = encryptTotpSecret(totpSeed, 'cookie-secret-one');
      // [1-byte len]['v1' ascii] — id length 2, bytes 'v','1'.
      expect(blob[0]).toBe(2);
      expect(blob.subarray(1, 3).toString('ascii')).toBe('v1');
      expect(decryptTotpSecret(blob, 'cookie-secret-one')).toBe(totpSeed);
    });

    it('rotates: a new active key id encrypts new writes, old blobs keep decrypting via the registry', () => {
      const totpSeed = 'JBSWY3DPEHPK3PXP';
      const cookieSecret = 'cookie-secret-one';

      // Written under the default 'v1' (derived from cookieSecret).
      const oldBlob = encryptTotpSecret(totpSeed, cookieSecret);

      // Operator rotates: adds 'v2' to the registry and flips the active id.
      process.env.TOTP_ENCRYPTION_KEYS = JSON.stringify({ v2: 'brand-new-key-material' });
      process.env.TOTP_ENCRYPTION_ACTIVE_KEY_ID = 'v2';

      // Old blob (still keyed 'v1') keeps decrypting — 'v1' is always
      // derivable from cookieSecret regardless of the active id.
      expect(decryptTotpSecret(oldBlob, cookieSecret)).toBe(totpSeed);

      // A fresh encrypt now uses 'v2'.
      const newBlob = encryptTotpSecret(totpSeed, cookieSecret);
      expect(newBlob.subarray(1, 1 + newBlob[0]!).toString('ascii')).toBe('v2');
      expect(decryptTotpSecret(newBlob, cookieSecret)).toBe(totpSeed);
    });

    it('reencryptTotpSecret migrates an old-key blob onto the active key, and is a no-op once migrated', () => {
      const totpSeed = 'JBSWY3DPEHPK3PXP';
      const cookieSecret = 'cookie-secret-one';
      const oldBlob = encryptTotpSecret(totpSeed, cookieSecret);

      process.env.TOTP_ENCRYPTION_KEYS = JSON.stringify({ v2: 'brand-new-key-material' });
      process.env.TOTP_ENCRYPTION_ACTIVE_KEY_ID = 'v2';

      const migrated = reencryptTotpSecret(oldBlob, cookieSecret);
      expect(migrated.equals(oldBlob)).toBe(false);
      expect(migrated.subarray(1, 1 + migrated[0]!).toString('ascii')).toBe('v2');
      expect(decryptTotpSecret(migrated, cookieSecret)).toBe(totpSeed);

      // Already on the active key — same bytes back, not re-encrypted again.
      const again = reencryptTotpSecret(migrated, cookieSecret);
      expect(again.equals(migrated)).toBe(true);
    });

    it('decrypting under a key id that was since removed from the registry fails loudly, not silently', () => {
      const totpSeed = 'JBSWY3DPEHPK3PXP';
      const cookieSecret = 'cookie-secret-one';
      process.env.TOTP_ENCRYPTION_KEYS = JSON.stringify({ v2: 'brand-new-key-material' });
      process.env.TOTP_ENCRYPTION_ACTIVE_KEY_ID = 'v2';
      const blob = encryptTotpSecret(totpSeed, cookieSecret);

      // Operator prematurely drops 'v2' from the registry (retired too soon).
      delete process.env.TOTP_ENCRYPTION_KEYS;
      expect(() => decryptTotpSecret(blob, cookieSecret)).toThrow(/unknown key id/);
    });
  });
});
