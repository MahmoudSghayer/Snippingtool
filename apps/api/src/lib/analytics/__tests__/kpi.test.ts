// KPI formulas exercised against fixtures with hand-computed expected
// values (the exact numbers are spelled out in each test's comments, not
// just asserted against whatever the code happens to produce).

import { payments, plans, subscriptions, userActivity, users, extensionInstalls } from '@sl/db';
import { closeTestDb, createTestDb, resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { newId } from '../../ids.js';
import {
  getChurn,
  getConversion,
  getExtensionInstalls,
  getMrrArr,
  getRetentionCohorts,
  getTotalRevenueCents,
  getVersionDistribution,
} from '../kpi.js';

import type { Database } from '@sl/db';

const { db, sql } = createTestDb();

async function planId(database: Database, code: string): Promise<string> {
  const row = await database.query.plans.findFirst({ where: eq(plans.code, code) });
  if (!row) throw new Error(`plan not seeded: ${code}`);
  return row.id;
}

async function createUser(database: Database, email: string, createdAt?: Date): Promise<string> {
  const id = newId();
  await database.insert(users).values({
    id,
    email,
    passwordHash: 'x',
    emailVerifiedAt: new Date(),
    ...(createdAt ? { createdAt } : {}),
  });
  return id;
}

describe('lib/analytics/kpi', () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await reseedPlans(db);
  });

  afterAll(async () => {
    await closeTestDb(sql);
  });

  it('getMrrArr: sums active non-lifetime subscriptions normalised to monthly, excludes trialing/canceled/lifetime', async () => {
    const proId = await planId(db, 'pro'); // 999 cents/month
    const ultimateId = await planId(db, 'ultimate'); // 1399 cents/month (Monthly + Mobile)
    const lifetimeId = await planId(db, 'lifetime'); // one_time, is_lifetime

    const u1 = await createUser(db, 'mrr-active-pro@example.com');
    const u2 = await createUser(db, 'mrr-active-ultimate@example.com');
    const u3 = await createUser(db, 'mrr-lifetime@example.com');
    const u4 = await createUser(db, 'mrr-trialing@example.com');

    await db.insert(subscriptions).values([
      { id: newId(), userId: u1, planId: proId, status: 'active' },
      { id: newId(), userId: u2, planId: ultimateId, status: 'active' },
      { id: newId(), userId: u3, planId: lifetimeId, status: 'lifetime', source: 'manual' }, // lifetime requires source manual/coupon
      {
        id: newId(),
        userId: u4,
        planId: proId,
        status: 'trialing',
        trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
      },
    ]);

    const { mrrCents, arrCents } = await getMrrArr(db);
    expect(mrrCents).toBe(999 + 1399); // 2398
    expect(arrCents).toBe(2398 * 12); // 28776
  });

  it('getTotalRevenueCents: sums succeeded payments within [from, to], excludes other statuses and out-of-range rows', async () => {
    const u1 = await createUser(db, 'revenue-1@example.com');

    await db.insert(payments).values([
      {
        id: newId(),
        userId: u1,
        provider: 'stripe',
        providerPaymentId: 'pay_in_range_1',
        amountCents: 500,
        status: 'succeeded',
        createdAt: new Date('2024-03-10T12:00:00Z'),
      },
      {
        id: newId(),
        userId: u1,
        provider: 'stripe',
        providerPaymentId: 'pay_in_range_2',
        amountCents: 250,
        status: 'succeeded',
        createdAt: new Date('2024-03-15T00:00:00Z'),
      },
      {
        id: newId(),
        userId: u1,
        provider: 'stripe',
        providerPaymentId: 'pay_failed',
        amountCents: 999,
        status: 'failed',
        createdAt: new Date('2024-03-12T00:00:00Z'),
      },
      {
        id: newId(),
        userId: u1,
        provider: 'stripe',
        providerPaymentId: 'pay_out_of_range',
        amountCents: 999,
        status: 'succeeded',
        createdAt: new Date('2024-04-01T00:00:00Z'),
      },
    ]);

    const total = await getTotalRevenueCents(db, { from: '2024-03-01', to: '2024-03-31' });
    expect(total).toBe(750);
  });

  it('getConversion: cohort = trial-plan subs started in range; converted = a later non-trial sub for the same user within 30d of the trial ending', async () => {
    // This schema never mutates a trial row into a paid one in place (DB
    // constraint forces trial_ends_at to NULL the moment status leaves
    // 'trialing', and checkout/admin-activate both refuse to touch a user
    // who still has a live subscription) — so conversion is modelled as a
    // *second*, separate subscription row for the same user. See
    // getConversion's own doc comment in kpi.ts.
    const trialId = await planId(db, 'trial');
    const proId = await planId(db, 'pro');
    const trialEndsBase = new Date('2024-02-10T00:00:00Z');
    const inRangeCreatedAt = new Date('2024-02-01T00:00:00Z'); // trial "started" inside [from, to]

    const uConverted = await createUser(db, 'conv-yes@example.com');
    const uStillTrialing = await createUser(db, 'conv-trialing@example.com');
    const uNeverConverted = await createUser(db, 'conv-never@example.com');
    const uTooLate = await createUser(db, 'conv-late@example.com');
    const uOutsideCohort = await createUser(db, 'conv-outside-cohort@example.com'); // trial started outside [from, to]

    // Trial rows (the cohort).
    await db.insert(subscriptions).values([
      {
        id: newId(),
        userId: uConverted,
        planId: trialId,
        status: 'expired',
        trialEndsAt: null,
        endedAt: trialEndsBase,
        createdAt: inRangeCreatedAt,
      },
      {
        id: newId(),
        userId: uStillTrialing,
        planId: trialId,
        status: 'trialing',
        trialEndsAt: trialEndsBase,
        createdAt: inRangeCreatedAt,
      },
      {
        id: newId(),
        userId: uNeverConverted,
        planId: trialId,
        status: 'expired',
        trialEndsAt: null,
        endedAt: trialEndsBase,
        createdAt: inRangeCreatedAt,
      },
      {
        id: newId(),
        userId: uTooLate,
        planId: trialId,
        status: 'expired',
        trialEndsAt: null,
        endedAt: trialEndsBase,
        createdAt: inRangeCreatedAt,
      },
      {
        id: newId(),
        userId: uOutsideCohort,
        planId: trialId,
        status: 'expired',
        trialEndsAt: null,
        endedAt: trialEndsBase,
        createdAt: new Date('2024-01-01T00:00:00Z'), // outside [2024-02-01, 2024-02-28]
      },
    ]);

    // Paid rows (some convert, some don't).
    await db.insert(subscriptions).values([
      {
        id: newId(),
        userId: uConverted,
        planId: proId,
        status: 'active',
        createdAt: new Date(trialEndsBase.getTime() + 5 * 86_400_000),
      }, // 5d after trial end: converted
      {
        id: newId(),
        userId: uTooLate,
        planId: proId,
        status: 'active',
        createdAt: new Date(trialEndsBase.getTime() + 40 * 86_400_000),
      }, // 40d: too late
      {
        id: newId(),
        userId: uOutsideCohort,
        planId: proId,
        status: 'active',
        createdAt: new Date(trialEndsBase.getTime() + 5 * 86_400_000),
      },
    ]);

    const result = await getConversion(db, { from: '2024-02-01', to: '2024-02-28' });
    expect(result.cohortSize).toBe(4); // excludes uOutsideCohort (trial started before the range)
    expect(result.converted).toBe(1); // only uConverted
    expect(result.rate).toBeCloseTo(0.25, 10);
  });

  it('getChurn: activeAtStart = live subs created before `from` and not yet canceled; churned = canceled/expired within range', async () => {
    const proId = await planId(db, 'pro');
    const from = new Date('2024-05-01T00:00:00Z');

    const uStillActive = await createUser(db, 'churn-still-active@example.com');
    const uChurned = await createUser(db, 'churn-churned@example.com');
    const uAlreadyGoneBeforeStart = await createUser(db, 'churn-already-gone@example.com');
    const uStartedAfterRange = await createUser(db, 'churn-started-after@example.com');
    const uExpiredViaEndedAt = await createUser(db, 'churn-expired-endedat@example.com');

    await db.insert(subscriptions).values([
      {
        id: newId(),
        userId: uStillActive,
        planId: proId,
        status: 'active',
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
      {
        id: newId(),
        userId: uChurned,
        planId: proId,
        status: 'canceled',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        canceledAt: new Date('2024-05-15T00:00:00Z'),
      },
      {
        id: newId(),
        userId: uAlreadyGoneBeforeStart,
        planId: proId,
        status: 'canceled',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        canceledAt: new Date('2024-04-01T00:00:00Z'), // canceled before `from` -> not active at start, not churned in range
      },
      {
        id: newId(),
        userId: uStartedAfterRange,
        planId: proId,
        status: 'active',
        createdAt: new Date('2024-05-10T00:00:00Z'),
      },
      {
        id: newId(),
        userId: uExpiredViaEndedAt,
        planId: proId,
        status: 'expired',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        endedAt: new Date('2024-05-20T00:00:00Z'),
      },
    ]);

    const result = await getChurn(db, { from: '2024-05-01', to: '2024-05-31' });
    // activeAtStart: uStillActive, uChurned, uExpiredViaEndedAt (all created before `from`, live status,
    // not canceled before `from`) = 3. uAlreadyGoneBeforeStart is excluded (canceled before `from`).
    expect(result.activeAtStart).toBe(3);
    // churned: uChurned (canceled_at in range) + uExpiredViaEndedAt (ended_at in range, via fallback) = 2
    expect(result.churned).toBe(2);
    expect(result.rate).toBeCloseTo(2 / 3, 10);
    void from;
  });

  it('getRetentionCohorts: D7/D30 retention by signup week, exact-day activity match', async () => {
    // 2024-01-01 is a Monday.
    const week = '2024-01-01';
    const u1CreatedAt = new Date('2024-01-01T10:00:00Z');
    const u2CreatedAt = new Date('2024-01-03T08:00:00Z');
    const u3CreatedAt = new Date('2024-01-01T10:00:00Z');

    const u1 = await createUser(db, 'retention-1@example.com', u1CreatedAt);
    const u2 = await createUser(db, 'retention-2@example.com', u2CreatedAt);
    const u3 = await createUser(db, 'retention-3@example.com', u3CreatedAt);

    // u1: active exactly on day+7 and day+30 -> retained both.
    await db.insert(userActivity).values([
      {
        id: newId(),
        userId: u1,
        type: 'heartbeat',
        occurredAt: new Date(u1CreatedAt.getTime() + 7 * 86_400_000 + 5 * 3_600_000),
      },
      {
        id: newId(),
        userId: u1,
        type: 'heartbeat',
        occurredAt: new Date(u1CreatedAt.getTime() + 30 * 86_400_000 + 2 * 3_600_000),
      },
    ]);
    // u2, u3: no activity at all -> not retained.

    const cohorts = await getRetentionCohorts(db, { from: '2024-01-01', to: '2024-01-07' });
    expect(cohorts).toHaveLength(1);
    const cohort = cohorts[0]!;
    expect(cohort.cohortWeek).toBe(week);
    expect(cohort.cohortSize).toBe(3);
    expect(cohort.retainedD7).toBe(1);
    expect(cohort.retainedD30).toBe(1);
    expect(cohort.retentionD7).toBeCloseTo(1 / 3, 10);
    expect(cohort.retentionD30).toBeCloseTo(1 / 3, 10);
    void u2;
    void u3;
  });

  it('getExtensionInstalls / getVersionDistribution: only live (not-uninstalled) installs count', async () => {
    await db.insert(extensionInstalls).values([
      { id: newId(), installId: 'install-1', version: '1.2.0', browser: 'chrome' },
      { id: newId(), installId: 'install-2', version: '1.2.0', browser: 'chrome' },
      { id: newId(), installId: 'install-3', version: '1.1.0', browser: 'firefox' },
      {
        id: newId(),
        installId: 'install-4',
        version: '1.1.0',
        browser: 'firefox',
        uninstalledAt: new Date(),
      },
    ]);

    const installs = await getExtensionInstalls(db);
    expect(installs.total).toBe(3);
    expect(installs.byBrowser).toEqual({ chrome: 2, firefox: 1 });

    const versions = await getVersionDistribution(db);
    expect(versions).toEqual({ '1.2.0': 2, '1.1.0': 1 });
  });
});
