import { describe, expect, it } from 'vitest';

import { normaliseEmailForAbuseCheck } from '../src/email-normalise.js';

describe('normaliseEmailForAbuseCheck', () => {
  it('lower-cases the domain for every provider', () => {
    expect(normaliseEmailForAbuseCheck('Player@Example.COM')).toBe('player@example.com');
  });

  it('lower-cases the local part too (used only as a matching key)', () => {
    expect(normaliseEmailForAbuseCheck('PLAYER@example.com')).toBe('player@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseEmailForAbuseCheck('  player@example.com  ')).toBe('player@example.com');
  });

  it('strips dots from the local part on gmail.com', () => {
    expect(normaliseEmailForAbuseCheck('p.l.a.yer@gmail.com')).toBe('player@gmail.com');
  });

  it('strips a +tag from the local part on gmail.com', () => {
    expect(normaliseEmailForAbuseCheck('player+altaccount@gmail.com')).toBe('player@gmail.com');
  });

  it('strips both dots and a +tag together on gmail.com', () => {
    expect(normaliseEmailForAbuseCheck('p.layer+sniper2@gmail.com')).toBe('player@gmail.com');
  });

  it('canonicalises googlemail.com to gmail.com and applies the same stripping', () => {
    expect(normaliseEmailForAbuseCheck('p.layer+alt@googlemail.com')).toBe('player@gmail.com');
  });

  it('makes obviously-equivalent gmail addresses collide', () => {
    const a = normaliseEmailForAbuseCheck('sniper.pro+trial1@gmail.com');
    const b = normaliseEmailForAbuseCheck('SniperPro+trial2@GoogleMail.com');
    expect(a).toBe(b);
    expect(a).toBe('sniperpro@gmail.com');
  });

  it('does NOT strip dots for a non-gmail provider', () => {
    expect(normaliseEmailForAbuseCheck('p.layer@outlook.com')).toBe('p.layer@outlook.com');
  });

  it('does NOT strip a +tag for a non-gmail provider', () => {
    expect(normaliseEmailForAbuseCheck('player+tag@yahoo.com')).toBe('player+tag@yahoo.com');
  });

  it('does not treat a lookalike domain (evilgmail.com) as gmail', () => {
    expect(normaliseEmailForAbuseCheck('p.layer+x@evilgmail.com')).toBe('p.layer+x@evilgmail.com');
  });

  it('is a no-op fallback (lower-cased, trimmed) for input with no @', () => {
    expect(normaliseEmailForAbuseCheck('  NotAnEmail  ')).toBe('notanemail');
  });

  it('handles an empty string without throwing', () => {
    expect(normaliseEmailForAbuseCheck('')).toBe('');
  });

  it('is idempotent', () => {
    const once = normaliseEmailForAbuseCheck('P.layer+x@Gmail.com');
    expect(normaliseEmailForAbuseCheck(once)).toBe(once);
  });
});
