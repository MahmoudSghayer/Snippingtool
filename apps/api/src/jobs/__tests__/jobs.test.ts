// Job-level integration tests: `subscriptions.expire` transitions a
// past-due trial to `expired` and revokes its license; `abuse.scan` creates
// a `velocity` flag from a device-registration-velocity fixture.

import { devices, flags, licenses, plans, subscriptions, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { hashSecret } from '../../lib/crypto.js';
import { newId } from '../../lib/ids.js';
import { reseedPlans } from '../../test/reseed-reference-data.js';
import abuseScanJob from '../abuse.scan.job.js';
import subscriptionsExpireJob from '../subscriptions.expire.job.js';

import type { JobContext } from '../types.js';
import type { Job } from 'bullmq';
import type { FastifyInstance } from 'fastify';

const noopLog: JobContext['log'] = { info: () => undefined, warn: () => undefined, error: () => undefined };

function jobContext(app: FastifyInstance): JobContext {
  return { db: app.db, redis: app.redis, env: app.config, mailer: app.mailer, log: noopLog };
}

async function createVerifiedUser(app: FastifyInstance, email: string): Promise<string> {
  const id = newId();
  await app.db.insert(users).values({ id, email, passwordHash: await hashSecret('irrelevant-password-123'), emailVerifiedAt: new Date() });
  return id;
}

describe('subscriptions.expire job', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await reseedPlans(app.db);
  });

  it('expires a trial past trial_ends_at and revokes its license', async () => {
    const userId = await createVerifiedUser(app, 'expiring-trial@example.com');
    const trialPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'trial') });

    const [sub] = await app.db
      .insert(subscriptions)
      .values({
        id: newId(),
        userId,
        planId: trialPlan!.id,
        status: 'trialing',
        currentPeriodStart: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: null,
        trialEndsAt: new Date(Date.now() - 1000), // already past
        cancelAtPeriodEnd: false,
        autoRenew: false,
        source: 'manual',
      })
      .returning();
    const [license] = await app.db
      .insert(licenses)
      .values({
        id: newId(),
        subscriptionId: sub!.id,
        userId,
        keyHash: `hash_${newId()}`,
        keyPrefix: 'SL-EXPT',
        status: 'active',
        maxDevices: 1,
        expiresAt: sub!.trialEndsAt,
      })
      .returning();

    await subscriptionsExpireJob.processor({} as Job, jobContext(app));

    const after = await app.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, sub!.id) });
    expect(after!.status).toBe('expired');
    expect(after!.endedAt).toBeTruthy();

    const licenseAfter = await app.db.query.licenses.findFirst({ where: eq(licenses.id, license!.id) });
    expect(licenseAfter!.status).toBe('revoked');
    expect(licenseAfter!.revokedReason).toBe('subscription_expired');
  });

  it('does not touch a trial whose trial_ends_at is still in the future', async () => {
    const userId = await createVerifiedUser(app, 'active-trial@example.com');
    const trialPlan = await app.db.query.plans.findFirst({ where: eq(plans.code, 'trial') });

    const [sub] = await app.db
      .insert(subscriptions)
      .values({
        id: newId(),
        userId,
        planId: trialPlan!.id,
        status: 'trialing',
        currentPeriodStart: new Date(),
        currentPeriodEnd: null,
        trialEndsAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
        autoRenew: false,
        source: 'manual',
      })
      .returning();

    await subscriptionsExpireJob.processor({} as Job, jobContext(app));

    const after = await app.db.query.subscriptions.findFirst({ where: eq(subscriptions.id, sub!.id) });
    expect(after!.status).toBe('trialing');
  });
});

describe('abuse.scan job', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await reseedPlans(app.db);
  });

  it('creates a velocity flag when more devices than the configured threshold register from the same IP within 24h', async () => {
    const sharedIp = '203.0.113.77';
    const userIds: string[] = [];
    // Default threshold (no system_config row seeded here) is 5 — 7 devices
    // from the same IP, each a distinct user, crosses it.
    for (let i = 0; i < 7; i++) {
      const userId = await createVerifiedUser(app, `velocity-user-${i}@example.com`);
      userIds.push(userId);
      await app.db.insert(devices).values({
        id: newId(),
        userId,
        fingerprintHash: `fp-velocity-${i}`,
        lastIp: sharedIp,
        status: 'active',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });
    }

    await abuseScanJob.processor({} as Job, jobContext(app));

    const flagRows = await app.db.query.flags.findMany({ where: eq(flags.kind, 'velocity') });
    expect(flagRows.length).toBeGreaterThanOrEqual(7);
    const evidence = flagRows[0]!.evidence as Record<string, unknown>;
    expect(evidence.detector).toBe('velocity.device_registration');
    expect(evidence.ip).toBe(sharedIp);

    // Every involved user got their own flag row.
    for (const userId of userIds) {
      const userFlags = await app.db.query.flags.findMany({ where: and(eq(flags.userId, userId), eq(flags.kind, 'velocity')) });
      expect(userFlags).toHaveLength(1);
    }
  });

  it('does not flag device counts at or below the threshold', async () => {
    const sharedIp = '203.0.113.88';
    for (let i = 0; i < 3; i++) {
      const userId = await createVerifiedUser(app, `low-velocity-user-${i}@example.com`);
      await app.db.insert(devices).values({
        id: newId(),
        userId,
        fingerprintHash: `fp-lowvelocity-${i}`,
        lastIp: sharedIp,
        status: 'active',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });
    }

    await abuseScanJob.processor({} as Job, jobContext(app));

    const flagRows = await app.db.query.flags.findMany({ where: eq(flags.kind, 'velocity') });
    expect(flagRows).toHaveLength(0);
  });
});
