import { describe, expect, it } from 'vitest';

import {
  banCheckResultSchema,
  createBanRequestSchema,
  flagDtoSchema,
  liftBanRequestSchema,
  reviewFlagRequestSchema,
} from '../../src/schemas/moderation.js';

describe('createBanRequestSchema', () => {
  it('accepts an account ban with no value', () => {
    const result = createBanRequestSchema.safeParse({
      type: 'account',
      userId: '0198f2b1-0000-7000-8000-000000000001',
      reason: 'chargeback abuse',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an ip ban with a value and no userId', () => {
    const result = createBanRequestSchema.safeParse({
      type: 'ip',
      value: '203.0.113.0',
      reason: 'velocity abuse',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a request with no reason', () => {
    const result = createBanRequestSchema.safeParse({ type: 'device', value: 'abc123' });
    expect(result.success).toBe(false);
  });

  it('accepts an optional expiresAt', () => {
    const result = createBanRequestSchema.safeParse({
      type: 'hwid',
      value: 'hwid-123',
      reason: 'multi-account',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('liftBanRequestSchema', () => {
  it('requires a reason', () => {
    expect(liftBanRequestSchema.safeParse({}).success).toBe(false);
    expect(liftBanRequestSchema.safeParse({ reason: 'appeal accepted' }).success).toBe(true);
  });
});

describe('banCheckResultSchema', () => {
  it('accepts a not-banned result', () => {
    expect(banCheckResultSchema.safeParse({ banned: false, ban: null }).success).toBe(true);
  });

  it('accepts a banned result carrying the ban row', () => {
    const result = banCheckResultSchema.safeParse({
      banned: true,
      ban: {
        id: '0198f2b1-0000-7000-8000-000000000002',
        userId: '0198f2b1-0000-7000-8000-000000000001',
        type: 'account',
        value: '',
        reason: 'chargeback',
        issuedBy: null,
        expiresAt: null,
        liftedAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('flagDtoSchema', () => {
  it('accepts a well-formed flag row', () => {
    const result = flagDtoSchema.safeParse({
      id: '0198f2b1-0000-7000-8000-000000000003',
      userId: '0198f2b1-0000-7000-8000-000000000001',
      kind: 'trial_abuse',
      severity: 'high',
      evidence: { detector: 'trial.email', matchedIds: ['abc'] },
      status: 'open',
      reviewedBy: null,
      reviewedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid kind', () => {
    const result = flagDtoSchema.safeParse({
      id: '0198f2b1-0000-7000-8000-000000000003',
      userId: '0198f2b1-0000-7000-8000-000000000001',
      kind: 'not_a_real_kind',
      severity: 'high',
      evidence: {},
      status: 'open',
      reviewedBy: null,
      reviewedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('reviewFlagRequestSchema', () => {
  it('accepts reviewed and dismissed as the only terminal statuses', () => {
    expect(reviewFlagRequestSchema.safeParse({ status: 'reviewed', reason: 'confirmed' }).success).toBe(true);
    expect(reviewFlagRequestSchema.safeParse({ status: 'dismissed', reason: 'false positive' }).success).toBe(true);
    expect(reviewFlagRequestSchema.safeParse({ status: 'open', reason: 'x' }).success).toBe(false);
  });
});
