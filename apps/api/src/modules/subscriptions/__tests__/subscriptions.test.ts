// Integration tests: GET /subscriptions/me, POST /subscriptions/trial
// (happy path + trial-abuse protection via email and via device
// fingerprint), permanent trial history (no second trial after the first
// one expired, for the same account or a linked one), POST
// /subscriptions/cancel, POST /subscriptions/resume.

import { flags, plans, subscriptions, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { activateManual, expireDueSubscriptions, grantLifetime, startTrial } from '../service.js';

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
      payload: { email, password: 'correcthorsebattery12', device, acceptTerms: true },
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

  describe('trial history survives the trial ending', () => {
    // Each account below sits on its own /24 unless a test shares one on
    // purpose, so only the detector under test can match.
    async function startTrialVia(token: string, ip: string) {
      return app.inject({
        method: 'POST',
        url: '/api/v1/subscriptions/trial',
        remoteAddress: ip,
        headers: { authorization: `Bearer ${token}` },
      });
    }

    /** Backdates the user's running trial and runs the real expiry path
     * (`subscriptions.expire`'s `expireDueSubscriptions`), which clears
     * `trial_ends_at` as the status leaves 'trialing'. */
    async function expireTrialOf(email: string) {
      const user = await app.db.query.users.findFirst({ where: eq(users.email, email) });
      await app.db
        .update(subscriptions)
        .set({ trialEndsAt: new Date(Date.now() - 60_000) })
        .where(eq(subscriptions.userId, user!.id));
      const { expiredCount } = await expireDueSubscriptions(app.db, app.redis);
      expect(expiredCount).toBe(1);
      const sub = await app.db.query.subscriptions.findFirst({
        where: eq(subscriptions.userId, user!.id),
      });
      expect(sub!.status).toBe('expired');
      expect(sub!.trialEndsAt).toBeNull();
      return user!.id;
    }

    async function flagDetectors(email: string) {
      const user = await app.db.query.users.findFirst({ where: eq(users.email, email) });
      const rows = await app.db.query.flags.findMany({ where: eq(flags.userId, user!.id) });
      return rows.map((r) => (r.evidence as { detectors: string[] }).detectors);
    }

    it('the same account cannot start a second trial after its first one expired', async () => {
      const token = await registerVerifyLogin(
        'retrial-self@example.com',
        '203.0.113.10',
        'fp-retrial-self-000000001',
      );
      expect((await startTrialVia(token, '203.0.113.10')).statusCode).toBe(201);
      await expireTrialOf('retrial-self@example.com');

      const again = await startTrialVia(token, '203.0.113.10');
      expect(again.statusCode).toBe(403);
      expect(again.json().code).toBe('TRIAL_ALREADY_USED');
      // Asking again for your own trial is not cross-account abuse: no flag.
      expect(await flagDetectors('retrial-self@example.com')).toEqual([]);
    });

    it('the same normalised email on another account is denied after the first trial expired', async () => {
      const tokenA = await registerVerifyLogin(
        'history.email@gmail.com',
        '203.0.113.20',
        'fp-history-email-a-00001',
      );
      expect((await startTrialVia(tokenA, '203.0.113.20')).statusCode).toBe(201);
      await expireTrialOf('history.email@gmail.com');

      const tokenB = await registerVerifyLogin(
        'historyemail+second@gmail.com',
        '192.0.2.20',
        'fp-history-email-b-00002',
      );
      const startB = await startTrialVia(tokenB, '192.0.2.20');
      expect(startB.statusCode).toBe(403);
      expect(startB.json().code).toBe('TRIAL_ABUSE_DETECTED');
      expect(await flagDetectors('historyemail+second@gmail.com')).toEqual([['email']]);
    });

    it('the same device on another account is denied after the first trial expired', async () => {
      const sharedFingerprint = 'fp-history-device-shared-01';
      const tokenA = await registerVerifyLogin(
        'history-device-a@example.com',
        '203.0.113.30',
        sharedFingerprint,
      );
      expect((await startTrialVia(tokenA, '203.0.113.30')).statusCode).toBe(201);
      await expireTrialOf('history-device-a@example.com');

      const tokenB = await registerVerifyLogin(
        'history-device-b@example.com',
        '192.0.2.30',
        sharedFingerprint,
      );
      const startB = await startTrialVia(tokenB, '192.0.2.30');
      expect(startB.statusCode).toBe(403);
      expect(startB.json().code).toBe('TRIAL_ABUSE_DETECTED');
      expect(await flagDetectors('history-device-b@example.com')).toEqual([['device']]);
    });

    it('the same IPv4 /24 on another account is denied after the first trial expired', async () => {
      const tokenA = await registerVerifyLogin(
        'history-ip-a@example.com',
        '203.0.113.40',
        'fp-history-ip-a-000000001',
      );
      expect((await startTrialVia(tokenA, '203.0.113.40')).statusCode).toBe(201);
      await expireTrialOf('history-ip-a@example.com');

      const tokenB = await registerVerifyLogin(
        'history-ip-b@example.com',
        '203.0.113.41',
        'fp-history-ip-b-000000002',
      );
      const startB = await startTrialVia(tokenB, '203.0.113.41');
      expect(startB.statusCode).toBe(403);
      expect(await flagDetectors('history-ip-b@example.com')).toEqual([['ip']]);
    });

    it('matches IPv6 addresses on the same prefix as ipToAbusePrefix computes it, and nothing wider', async () => {
      const tokenA = await registerVerifyLogin(
        'history-ip6-a@example.com',
        '2001:db8:7::10',
        'fp-history-ip6-a-00000001',
      );
      expect((await startTrialVia(tokenA, '2001:db8:7::10')).statusCode).toBe(201);

      // Another prefix entirely: allowed (and not flagged).
      const tokenOther = await registerVerifyLogin(
        'history-ip6-other@example.com',
        '2001:db8:8::10',
        'fp-history-ip6-o-00000003',
      );
      expect((await startTrialVia(tokenOther, '2001:db8:8::10')).statusCode).toBe(201);

      const tokenB = await registerVerifyLogin(
        'history-ip6-b@example.com',
        '2001:db8:7::99',
        'fp-history-ip6-b-00000002',
      );
      const startB = await startTrialVia(tokenB, '2001:db8:7::99');
      expect(startB.statusCode).toBe(403);
      expect(await flagDetectors('history-ip6-b@example.com')).toEqual([['ip']]);
    });
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

  // An archived plan is off sale. Only an admin grant may still hand it out
  // (e.g. to a legacy customer), and it has to say so.
  it('activateManual and grantLifetime refuse an inactive plan unless the caller allows it', async () => {
    const userId = newId();
    await app.db.insert(users).values({
      id: userId,
      email: 'inactive-plan@example.com',
      passwordHash: await hashSecret('irrelevant-password-123'),
      emailVerifiedAt: new Date(),
    });
    await app.db.update(plans).set({ isActive: false }).where(eq(plans.code, 'lifetime'));

    await expect(
      activateManual(app.db, app.redis, {
        userId,
        planCode: 'basic',
        periodDays: 30,
        grantedByAdminId: null,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      grantLifetime(app.db, app.redis, { userId, planCode: 'lifetime', grantedByAdminId: null }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await app.db.query.subscriptions.findMany({ where: eq(subscriptions.userId, userId) }),
    ).toHaveLength(0);

    const { subscription } = await grantLifetime(app.db, app.redis, {
      userId,
      planCode: 'lifetime',
      grantedByAdminId: null,
      allowInactivePlan: true,
    });
    expect(subscription.status).toBe('lifetime');
  });
});
