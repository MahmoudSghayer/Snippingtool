import { describe, expect, it } from 'vitest';

import {
  CROCKFORD_ALPHABET,
  LICENSE_KEY_RANDOM_BYTES,
  computeChecksum,
  generateLicenseKey,
  normaliseLicenseKey,
  validateLicenseKeyFormat,
} from '../src/license-key.js';

const KEY_SHAPE =
  /^SL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

describe('generateLicenseKey', () => {
  it('produces the SL-XXXX-XXXX-XXXX-XXXX shape using only Crockford base32 characters', () => {
    const key = generateLicenseKey(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(key).toMatch(KEY_SHAPE);
  });

  it('is deterministic for the same input bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(generateLicenseKey(bytes)).toBe(generateLicenseKey(bytes));
  });

  it('matches a known reference vector (all-zero bytes)', () => {
    expect(generateLicenseKey(new Uint8Array(9))).toBe('SL-0000-0000-0000-0000');
  });

  it('matches a known reference vector (mixed bytes)', () => {
    const key = generateLicenseKey(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(key).toBe('SL-0410-6105-0R3G-G2RM');
  });

  it('matches a known reference vector (all-0xFF bytes)', () => {
    const key = generateLicenseKey(new Uint8Array(9).fill(255));
    expect(key).toBe('SL-ZZZZ-ZZZZ-ZZZZ-ZZ5Q');
  });

  it('never emits the excluded look-alike characters I, L, O, U (outside the fixed SL- prefix)', () => {
    for (let seed = 0; seed < 50; seed++) {
      const bytes = new Uint8Array(LICENSE_KEY_RANDOM_BYTES).map(
        (_, i) => (seed * 37 + i * 91) % 256,
      );
      const key = generateLicenseKey(bytes);
      const dataPortion = key.slice('SL-'.length);
      expect(dataPortion).not.toMatch(/[ILOU]/);
    }
  });

  it('throws when given the wrong number of random bytes', () => {
    expect(() => generateLicenseKey(new Uint8Array(8))).toThrow();
    expect(() => generateLicenseKey(new Uint8Array(10))).toThrow();
  });

  it('every generated key passes its own format validation', () => {
    for (let seed = 0; seed < 25; seed++) {
      const bytes = new Uint8Array(LICENSE_KEY_RANDOM_BYTES).map(
        (_, i) => (seed * 13 + i * 7) % 256,
      );
      const key = generateLicenseKey(bytes);
      expect(validateLicenseKeyFormat(key)).toEqual({ valid: true, normalised: key });
    }
  });
});

describe('computeChecksum', () => {
  it('is sensitive to character order (catches transpositions)', () => {
    // Swap two interior payload characters and expect a different checksum.
    const original = '041061050R3GG2';
    const swapped = '041061055R0GG2';
    expect(computeChecksum(original)).not.toBe(computeChecksum(swapped));
  });

  it('throws on a payload of the wrong length', () => {
    expect(() => computeChecksum('SHORT')).toThrow();
  });

  it('throws on an invalid Crockford character', () => {
    expect(() => computeChecksum('0000000000000U')).toThrow(); // 'U' is not in the alphabet
  });

  it('every alphabet character has a valid index', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
  });
});

describe('normaliseLicenseKey', () => {
  it('accepts the canonical form unchanged', () => {
    expect(normaliseLicenseKey('SL-0410-6105-0R3G-G2RM')).toBe('SL-0410-6105-0R3G-G2RM');
  });

  it('is case-insensitive', () => {
    expect(normaliseLicenseKey('sl-0410-6105-0r3g-g2rm')).toBe('SL-0410-6105-0R3G-G2RM');
  });

  it('tolerates missing dashes and stray whitespace', () => {
    expect(normaliseLicenseKey('  SL 0410610 50R3GG2RM  ')).toBe('SL-0410-6105-0R3G-G2RM');
  });

  it('tolerates a missing SL- prefix entirely', () => {
    expect(normaliseLicenseKey('0410-6105-0R3G-G2RM')).toBe('SL-0410-6105-0R3G-G2RM');
  });

  it('remaps ambiguous look-alike characters (O->0, I/L->1)', () => {
    // Take a valid key and substitute its digits with their look-alikes.
    const key = generateLicenseKey(new Uint8Array(9)); // SL-0000-0000-0000-0000
    const withLookAlikes = key.replace(/0/g, 'O');
    expect(normaliseLicenseKey(withLookAlikes)).toBe(key);
  });

  it('rejects a key with the wrong length', () => {
    expect(normaliseLicenseKey('SL-0410-6105-0R3G')).toBeNull();
    expect(normaliseLicenseKey('SL-0410-6105-0R3G-G2RM-EXTRA')).toBeNull();
  });

  it('rejects a key containing U, which Crockford never remaps', () => {
    expect(normaliseLicenseKey('SL-UUUU-UUUU-UUUU-UUUU')).toBeNull();
  });

  it('returns null (never throws) for garbage input', () => {
    expect(normaliseLicenseKey('')).toBeNull();
    expect(normaliseLicenseKey('not a license key at all!!')).toBeNull();
  });
});

describe('validateLicenseKeyFormat', () => {
  it('validates a correctly generated key', () => {
    const key = generateLicenseKey(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]));
    expect(validateLicenseKeyFormat(key)).toEqual({ valid: true, normalised: key });
  });

  it('rejects a key with a corrupted checksum (single mistyped character)', () => {
    const key = generateLicenseKey(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]));
    // Flip the first payload character to something else in the alphabet.
    const firstDataChar = key[3]!;
    const replacement = firstDataChar === '0' ? '1' : '0';
    const tampered = key.slice(0, 3) + replacement + key.slice(4);
    const result = validateLicenseKeyFormat(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('CHECKSUM_MISMATCH');
    expect(result.normalised).toBe(tampered);
  });

  it('reports MALFORMED for input that cannot even be normalised', () => {
    const result = validateLicenseKeyFormat('garbage');
    expect(result).toEqual({ valid: false, normalised: null, reason: 'MALFORMED' });
  });

  it('accepts input needing normalisation (lowercase, no dashes, look-alikes)', () => {
    const key = generateLicenseKey(new Uint8Array(9)); // SL-0000-0000-0000-0000
    const messy = key.toLowerCase().replace(/-/g, '').replace(/0/g, 'o');
    const result = validateLicenseKeyFormat(messy);
    expect(result.valid).toBe(true);
    expect(result.normalised).toBe(key);
  });
});
