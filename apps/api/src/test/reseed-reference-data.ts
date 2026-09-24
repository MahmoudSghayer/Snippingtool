// resetDatabase() (from @sl/db/test-utils) truncates every application
// table, including reference/config data (`plans`, `feature_toggles`,
// `system_config`) — this is @sl/db's own tested contract (see
// packages/db/test/seed.test.ts, which likewise calls `seed()` itself after
// `resetDatabase()` whenever a test needs that data), not something to
// special-case away in resetDatabase() itself.
//
// A test file whose routes depend on that reference data existing (e.g.
// `POST /subscriptions/trial` looking up the `trial` plan by code) calls
// this after `resetDatabase()` in its `beforeEach`, instead of pulling in
// `@sl/db`'s full `seed()` (which also creates a super-admin/dev user from
// env vars this test suite doesn't set, and opens its own DB connection).
// Mirrors the plan rows packages/db/src/seed.ts creates.

import { plans, type Database } from '@sl/db';
import { eq } from 'drizzle-orm';

const PLAN_SEEDS = [
  {
    code: 'trial',
    name: 'Trial',
    priceCents: 0,
    interval: 'month',
    isLifetime: false,
    deviceLimit: 1,
    sortOrder: 0,
    isActive: true,
  },
  {
    code: 'basic',
    name: 'Basic',
    priceCents: 499,
    interval: 'month',
    isLifetime: false,
    deviceLimit: 1,
    sortOrder: 1,
    isActive: false,
  },
  {
    code: 'pro',
    name: 'Monthly',
    priceCents: 999,
    interval: 'month',
    isLifetime: false,
    deviceLimit: 2,
    sortOrder: 1,
    isActive: true,
  },
  {
    code: 'ultimate',
    name: 'Monthly + Mobile',
    priceCents: 1399,
    interval: 'month',
    isLifetime: false,
    deviceLimit: 3,
    sortOrder: 2,
    isActive: true,
  },
  {
    code: 'lifetime',
    name: 'Season',
    priceCents: 2499,
    interval: 'one_time',
    isLifetime: true,
    deviceLimit: 3,
    sortOrder: 3,
    isActive: true,
  },
] as const;

export async function reseedPlans(db: Database): Promise<void> {
  for (const plan of PLAN_SEEDS) {
    const existing = await db.query.plans.findFirst({ where: eq(plans.code, plan.code) });
    if (existing) continue;
    await db.insert(plans).values({
      code: plan.code,
      name: plan.name,
      description: `${plan.name} plan (test fixture).`,
      priceCents: plan.priceCents,
      interval: plan.interval,
      isLifetime: plan.isLifetime,
      deviceLimit: plan.deviceLimit,
      features: {},
      sortOrder: plan.sortOrder,
      isActive: plan.isActive,
    });
  }
}
