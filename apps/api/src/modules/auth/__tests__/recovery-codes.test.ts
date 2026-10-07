// F6: recovery codes must be uniform draws from a fixed alphabet (no padding,
// no case-collapse), giving the full 8-character entropy the XXXX-XXXX format
// implies.
import { describe, expect, it } from 'vitest';

import { generateRecoveryCodes } from '../totp.js';

// 0-9 and A-Z minus the ambiguous I, L, O, U (Crockford base32).
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

describe('generateRecoveryCodes (F6)', () => {
  it('returns 10 codes in XXXX-XXXX format from the allowed alphabet', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c, c).toMatch(CODE_RE);
  });

  it('honours the requested count', () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });

  it('is high-entropy: no padding artifact and effectively no collisions at scale', () => {
    const N = 5000;
    const all = Array.from({ length: N }, () => generateRecoveryCodes(1)[0]!);
    // Uniqueness: 40 bits/code → collisions over 5k samples are vanishingly rare.
    expect(new Set(all).size).toBe(N);

    // The old implementation 0-padded short draws, so trailing-zero runs were
    // over-represented. With uniform draws, a given character appears ~1/32 of
    // the time, so '0' should not dominate the last position.
    const lastChars = all.map((c) => c.at(-1)!);
    const zeros = lastChars.filter((ch) => ch === '0').length;
    expect(zeros / N, 'last character is uniform, not padded').toBeLessThan(0.1);
  });
});
