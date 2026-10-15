import { describe, expect, it } from 'vitest';

import {
  bootstrapResponseSchema,
  entitlementBlobClaimsSchema,
  heartbeatResponseSchema,
} from '../../src/schemas/extension.js';

// The claims `apps/api`'s DefaultEntitlementProvider signs into the
// entitlement blob (a compact EdDSA JWS) and the extension reads back,
// after verifying the signature, as its only trusted source of features,
// kill-switch state and expiry for a cached entitlement.
const snapshot = {
  plan: 'pro',
  planName: 'Pro',
  status: 'active',
  features: ['assist.ranker', 'automation.autobuyer'],
  deviceLimit: 2,
  expiresAt: '2026-10-20T00:00:00.000Z',
  currentPeriodEnd: '2026-10-20T00:00:00.000Z',
  license: null,
};

const claims = {
  snapshot,
  deviceId: '11111111-1111-4111-8111-111111111111',
  killSwitchActive: false,
  sub: '22222222-2222-4222-8222-222222222222',
  iat: 1_790_000_000,
  exp: 1_790_093_600,
};

describe('entitlementBlobClaimsSchema', () => {
  it('accepts the claims the server signs, kill switch included', () => {
    const result = entitlementBlobClaimsSchema.safeParse(claims);
    expect(result.success).toBe(true);
    expect(result.success && result.data.killSwitchActive).toBe(false);
  });

  it('accepts a blob signed before the kill switch was a claim, leaving it undefined', () => {
    const { killSwitchActive: _omit, ...legacy } = claims;
    const result = entitlementBlobClaimsSchema.safeParse(legacy);
    expect(result.success).toBe(true);
    expect(result.success && result.data.killSwitchActive).toBeUndefined();
  });

  it('rejects claims without an expiry or issue time', () => {
    const { exp: _exp, ...noExp } = claims;
    const { iat: _iat, ...noIat } = claims;
    expect(entitlementBlobClaimsSchema.safeParse(noExp).success).toBe(false);
    expect(entitlementBlobClaimsSchema.safeParse(noIat).success).toBe(false);
  });

  it('rejects a non-boolean kill switch', () => {
    expect(
      entitlementBlobClaimsSchema.safeParse({ ...claims, killSwitchActive: 'false' }).success,
    ).toBe(false);
  });
});

// Bootstrap carries the signed-in user's own email (shown in the extension);
// heartbeat is the cheap 10-minute refresh and never carries it.
describe('bootstrap vs heartbeat response: email', () => {
  it('bootstrap requires a valid email', () => {
    const email = bootstrapResponseSchema.shape.email;
    expect(email).toBeDefined();
    expect(email.safeParse('user@example.com').success).toBe(true);
    expect(email.safeParse('not-an-email').success).toBe(false);
    expect(email.safeParse(undefined).success).toBe(false);
  });

  it('heartbeat has no email field (nor userId)', () => {
    expect(Object.keys(heartbeatResponseSchema.shape)).not.toContain('email');
    expect(Object.keys(heartbeatResponseSchema.shape)).not.toContain('userId');
  });
});
