import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEVICE_LIMITS, PLAN_FEATURES, planHasFeature } from '../../src/constants/plans.js';
import { paginatedResponseSchema, paginationQuerySchema } from '../../src/schemas/pagination.js';

describe('paginationQuerySchema', () => {
  it('defaults limit to 50 when omitted', () => {
    const result = paginationQuerySchema.parse({});
    expect(result.limit).toBe(50);
  });

  it('coerces a string limit (as arrives on a query string) to a number', () => {
    const result = paginationQuerySchema.parse({ limit: '10' });
    expect(result.limit).toBe(10);
  });

  it('rejects a limit above the 200 cap', () => {
    expect(paginationQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});

describe('paginatedResponseSchema', () => {
  it('wraps an item schema into { items, nextCursor }', () => {
    const schema = paginatedResponseSchema(z.object({ id: z.string() }));
    const result = schema.safeParse({ items: [{ id: 'a' }], nextCursor: null });
    expect(result.success).toBe(true);
  });
});

describe('plan constants', () => {
  it('matches the device limits fixed by the plan (1,1,2,3,3)', () => {
    expect(DEVICE_LIMITS).toEqual({ trial: 1, basic: 1, pro: 2, ultimate: 3, lifetime: 3 });
  });

  it('makes ultimate a superset of pro', () => {
    for (const feature of PLAN_FEATURES.pro) {
      expect(planHasFeature('ultimate', feature)).toBe(true);
    }
  });

  it('only grants automation.autobuyer to ultimate and lifetime', () => {
    expect(planHasFeature('basic', 'automation.autobuyer')).toBe(false);
    expect(planHasFeature('pro', 'automation.autobuyer')).toBe(false);
    expect(planHasFeature('ultimate', 'automation.autobuyer')).toBe(true);
    expect(planHasFeature('lifetime', 'automation.autobuyer')).toBe(true);
  });
});
