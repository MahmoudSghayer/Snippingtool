import { describe, expect, it } from 'vitest';

import {
  loginRequestSchema,
  passwordSchema,
  registerRequestSchema,
} from '../../src/schemas/auth.js';

describe('passwordSchema', () => {
  it('accepts a password with a letter, a digit and enough length', () => {
    expect(passwordSchema.safeParse('correcthorse1').success).toBe(true);
  });

  it('rejects a too-short password', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
  });

  it('rejects a password with no digit', () => {
    expect(passwordSchema.safeParse('onlylettershere').success).toBe(false);
  });
});

describe('registerRequestSchema', () => {
  const validDevice = { fingerprint: 'a'.repeat(20) };

  it('lower-cases and trims the email', () => {
    const result = registerRequestSchema.safeParse({
      email: '  Player@Example.COM  ',
      password: 'correcthorse1',
      device: validDevice,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('player@example.com');
  });

  it('rejects a request missing a device fingerprint', () => {
    const result = registerRequestSchema.safeParse({
      email: 'player@example.com',
      password: 'correcthorse1',
    });
    expect(result.success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('does not enforce the strong-password policy on login (only on register/reset)', () => {
    const result = loginRequestSchema.safeParse({
      email: 'player@example.com',
      password: 'x',
      device: { fingerprint: 'a'.repeat(20) },
    });
    expect(result.success).toBe(true);
  });
});
