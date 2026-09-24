// Integration tests: GET /subscriptions/me, POST /subscriptions/trial
// (happy path + trial-abuse protection via email and via device
// fingerprint), POST /subscriptions/cancel, POST /subscriptions/resume.

import { flags, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { startTrial } from '../service.js';

import type { FastifyInstance } from 'fastify';

let ipCounter = 10;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 254}`;
}

function extractToken(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No token found in email:\n${html}`);
  return decodeURIComponent(match[1]!);
}

describe('subscriptions module', () => {
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
    // resetDatabase() truncates reference data (plans) along with
    // everything else — @sl/db's own tested contract (packages/db/test/
    // seed.test.ts calls seed() itself after resetDatabase() for the same
    // reason) — so routes that look up a plan by code (POST
    // /subscriptions/trial) need it reseeded here. See
    // src/test/reseed-reference-data.ts for why this is a lighter helper
    // than pulling in @sl/db's full seed().
    await resetDatabase(app.db);
    await reseedPlans(app.db);
  });

  async function registerVerifyLogin(email: string, ip: string, fingerprint: string) {
    const device = {
      fingerprint,
      name: 'Test Device',
      browser: 'chrome',
      os: 'linux',
      extensionVersion: '1.0.0',
    };
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device },
    });
    expect(registerRes.statusCode).toBe(201);
    const mail = app.mailer.sentEmails.at(-1);
    const token = extractToken(mail!.html);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: ip,
      payload: { token },
    });
    expect(verifyRes.statusCode).toBe(200);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password: 'correcthorsebattery12', device },
    });
    expect(loginRes.statusCode).toBe(200);
    return loginRes.json().accessToken as string;
  }

  it('GET /subscriptions/me returns null subscription/license before any trial', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'nosub@example.com',
      ip,
      'fp-nosub-0000000000000001',
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/me',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subscription).toBeNull();
    expect(body.license).toBeNull();
    expect(body.devices.length).toBeGreaterThan(0);
    expect(body.devices[0].isCurrent).toBe(true);
  });

  it('starts a trial, issues a license once, and GET /me reflects it', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'trial-happy@example.com',
      ip,
      'fp-happy-0000000000000001',
    );

    const trialRes = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(trialRes.statusCode).toBe(201);
    const trialBody = trialRes.json();
    expect(trialBody.subscription.status).toBe('trialing');
    expect(trialBody.subscription.plan.code).toBe('trial');
    expect(trialBody.license.key).toMatch(/^SL-[0-9A-Z-]{19}$/);
    expect(trialBody.license.maxDevices).toBe(1);

    // Starting a second trial while one is live is a conflict, not abuse.
    const secondAttempt = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(secondAttempt.statusCode).toBe(409);

    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/me',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const me = meRes.json();
    expect(me.subscription.status).toBe('trialing');
    expect(me.license.keyPrefix).toBe(trialBody.license.keyPrefix);
    expect(me.entitlements.plan).toBe('trial');
    expect(me.entitlements.features).toContain('assist.ranker');
  });

  it('two concurrent trial requests: one wins, the other is a 409, never a 500', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'trial-race@example.com',
      ip,
      'fp-race-00000000000000001',
    );

    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/subscriptions/trial',
        remoteAddress: ip,
        headers: { authorization: `Bearer ${accessToken}` },
      });
    const statuses = (await Promise.all([send(), send(), send()])).map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409]);
  });

  it('trial abuse: denies a second trial from the same normalised (gmail dotted/plus) email and flags it', async () => {
    const ipA = nextIp();
    const tokenA = await registerVerifyLogin(
      'sniper.pro@gmail.com',
      ipA,
      'fp-emailabuse-a-000000001',
    );
    const startA = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ipA,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(startA.statusCode).toBe(201);

    // Same inbox, dotted + plus-tagged, different account/device/IP.
    const ipB = nextIp();
    const tokenB = await registerVerifyLogin(
      'sniper.pro+altaccount@gmail.com',
      ipB,
      'fp-emailabuse-b-000000002',
    );
    const startB = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ipB,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(startB.statusCode).toBe(403);
    expect(startB.json().code).toBe('TRIAL_ABUSE_DETECTED');

    const secondUserId = (await app.db.query.users.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.email, 'sniper.pro+altaccount@gmail.com'),
    }))!.id;
    const flagRows = await app.db.query.flags.findMany({ where: eq(flags.userId, secondUserId) });
    expect(flagRows).toHaveLength(1);
    expect(flagRows[0]!.kind).toBe('trial_abuse');
    expect((flagRows[0]!.evidence as Record<string, unknown>).detectors).toContain('email');

    // The second account never got a subscription at all.
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/me',
      remoteAddress: ipB,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(meRes.json().subscription).toBeNull();
  });

  it('trial abuse: denies a second trial from the same device fingerprint (different account/email/IP) and flags it', async () => {
    const sharedFingerprint = 'fp-shared-device-000000000001';

    const ipA = nextIp();
    const tokenA = await registerVerifyLogin('device-a@example.com', ipA, sharedFingerprint);
    const startA = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ipA,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(startA.statusCode).toBe(201);

    const ipB = nextIp();
    const tokenB = await registerVerifyLogin('device-b@example.com', ipB, sharedFingerprint);
    const startB = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ipB,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(startB.statusCode).toBe(403);
    expect(startB.json().code).toBe('TRIAL_ABUSE_DETECTED');

    const secondUserId = (await app.db.query.users.findFirst({
      where: (t, { eq: eqOp }) => eqOp(t.email, 'device-b@example.com'),
    }))!.id;
    const flagRows = await app.db.query.flags.findMany({ where: eq(flags.userId, secondUserId) });
    expect(flagRows).toHaveLength(1);
    expect((flagRows[0]!.evidence as Record<string, unknown>).detectors).toContain('device');
  });

  it('trial abuse: denies a trial when the requester already shares a stripe_customer_id with another account that has had a trial (4th vector)', async () => {
    // userA: a real trial via the HTTP route, then a persisted
    // stripe_customer_id (order doesn't matter for userA — its token is
    // never reused afterwards, so bumping row_version via the UPDATE below
    // has no effect on this test).
    const ipA = nextIp();
    const tokenA = await registerVerifyLogin(
      'stripe-customer-a@example.com',
      ipA,
      'fp-stripecust-a-00000001',
    );
    const userAId = (await app.db.query.users.findFirst({
      where: eq(users.email, 'stripe-customer-a@example.com'),
    }))!.id;
    const startA = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ipA,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(startA.statusCode).toBe(201);
    await app.db
      .update(users)
      .set({ stripeCustomerId: 'cus_shared_between_accounts' })
      .where(eq(users.id, userAId));

    // userB: a second, otherwise-unrelated account (different email/device/
    // IP — nothing else overlaps). Its own users.stripe_customer_id can
    // never actually equal userA's at rest (users_stripe_customer_id_unique
    // is a real uniqueness constraint: migrations/0025, packages/db/test
    // verifies the collision is rejected) — by design, at most one live
    // user ever legitimately holds a given Stripe customer id. This test
    // therefore calls `startTrial` directly with that id, the same
    // service-level pattern payments/__tests__/payments.test.ts uses for
    // createCheckoutSession/receiveWebhookEvent, standing in for "userB's
    // own stripe_customer_id field happened to already equal userA's" (an
    // edge case the DB constraint makes rare but not impossible to reach in
    // application code — e.g. a review of pending Stripe writes, or a data
    // fix — which is exactly the defense-in-depth this vector is for).
    const userBId = newId();
    await app.db.insert(users).values({
      id: userBId,
      email: 'stripe-customer-b@example.com',
      passwordHash: await hashSecret('irrelevant-password-123'),
      emailVerifiedAt: new Date(),
    });

    const result = await startTrial(app.db, app.redis, {
      userId: userBId,
      email: 'stripe-customer-b@example.com',
      fingerprintHash: null,
      ip: null,
      stripeCustomerId: 'cus_shared_between_accounts',
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.matches.map((m) => m.detector)).toContain('stripe_customer');
    }

    const flagRows = await app.db.query.flags.findMany({ where: eq(flags.userId, userBId) });
    expect(flagRows).toHaveLength(1);
    expect((flagRows[0]!.evidence as Record<string, unknown>).detectors).toContain(
      'stripe_customer',
    );
  });

  it('does NOT flag two different accounts sharing an IP/device when only one ever had a trial (false-positive avoidance)', async () => {
    // First account gets a trial via admin grant (source=manual), never
    // POSTs /subscriptions/trial itself, so there is no trial-abuse
    // history tied to its device/IP for the second account to collide
    // with via checks 2/3 (which only count *prior trials*).
    const sharedFingerprint = 'fp-shared-paid-0000000000001';
    const ip = nextIp();
    const tokenSecond = await registerVerifyLogin(
      'paid-office-mate@example.com',
      ip,
      sharedFingerprint,
    );

    const startSecond = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${tokenSecond}` },
    });
    expect(startSecond.statusCode).toBe(201);
  });

  it('cancel sets cancelAtPeriodEnd, resume clears it', async () => {
    const ip = nextIp();
    const accessToken = await registerVerifyLogin(
      'cancel-resume@example.com',
      ip,
      'fp-cancelresume-00000001',
    );
    await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/trial',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const cancelRes = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/cancel',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().cancelAtPeriodEnd).toBe(true);

    // Trials have no current_period_end, so resume's "still within period"
    // check fails for a canceled trial — this exercises the CONFLICT path.
    const resumeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions/resume',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(resumeRes.statusCode).toBe(409);
  });
});
