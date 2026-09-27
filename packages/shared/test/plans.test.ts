// The per-build-target feature key lists (constants/plans.ts) are spelled
// out separately from FEATURE_KEYS so the listable build never bundles the
// automation keys; this keeps the three from drifting apart.

import { describe, expect, it } from 'vitest';

import { AUTOMATION_FEATURE_KEYS, FEATURE_KEYS, LISTABLE_FEATURE_KEYS } from '../src/constants/plans.js';

describe('feature key lists', () => {
  it('LISTABLE_FEATURE_KEYS and AUTOMATION_FEATURE_KEYS partition FEATURE_KEYS', () => {
    const union = [...LISTABLE_FEATURE_KEYS, ...AUTOMATION_FEATURE_KEYS];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it('keeps every automation key out of the listable list', () => {
    expect(LISTABLE_FEATURE_KEYS.some((k) => k.startsWith('automation.'))).toBe(false);
    expect(AUTOMATION_FEATURE_KEYS.every((k) => k.startsWith('automation.'))).toBe(true);
  });
});
