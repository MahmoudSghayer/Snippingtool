// The per-build-target feature key lists (constants/plans.ts) are spelled
// out separately from FEATURE_KEYS so the listable build never bundles the
// automation keys; this keeps the three from drifting apart.

import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_FEATURE_KEYS,
  FEATURE_KEYS,
  LISTABLE_FEATURE_KEYS,
  PLAN_CATALOGUE,
  PLAN_FEATURES,
  type FeatureKey,
  type PlanCode,
} from '../src/constants/plans.js';

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

// The API gates these routes by feature (apps/api `requireFeature`, task 8):
// ledger.recorder the trade/sniping ingest and reads, filter_rotation
// /filters, risk_meter /risk-events, dashboard.analytics /analytics/me and
// /market. A plan edit that drops one of them from a plan someone holds
// locks that person out of part of what they paid for, so fail loudly.
const GATED_FEATURES = [
  'ledger.recorder',
  'assist.filter_rotation',
  'assist.risk_meter',
  'dashboard.analytics',
] as const satisfies readonly FeatureKey[];

describe('plans a real user can hold keep every gated feature', () => {
  // Everything on sale, plus the trial, plus pro/ultimate/lifetime even
  // while `coming_soon` (legacy holders exist). `basic` is retired and
  // deliberately lacks all but the recorder: its holders get the 403.
  const held = new Set<PlanCode>(['trial', 'pro', 'ultimate', 'lifetime']);
  for (const [code, entry] of Object.entries(PLAN_CATALOGUE)) {
    if (entry.availability === 'available') held.add(code as PlanCode);
  }

  for (const plan of held) {
    it(`${plan} includes ${GATED_FEATURES.join(', ')}`, () => {
      for (const feature of GATED_FEATURES) {
        expect(PLAN_FEATURES[plan], `${plan} is missing ${feature}`).toContain(feature);
      }
    });
  }

  it('the retired basic plan still records trades (its holders see they are on an old plan)', () => {
    expect(PLAN_CATALOGUE.basic.availability).toBe('retired');
    expect(PLAN_FEATURES.basic).toContain('ledger.recorder');
  });
});
