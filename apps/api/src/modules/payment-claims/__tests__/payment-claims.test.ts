// PayPal.me payments: the buyer submits a transaction ID, an admin approves
// it, and approval issues (or extends) the pass and records the revenue.

import { adminUsers, licenses, payments, subscriptions, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';
import { reseedPlans } from '../../../test/reseed-reference-data.js';
import { startTrial } from '../../subscriptions/service.js';

import type { FastifyInstance } from 'fastify';

const DAY_MS = 24 * 60 * 60 * 1000;
let txnCounter = 0;
function txn(): string {
  txnCounter += 1;
  return `9TX${String(txnCounter).padStart(14, '0')}`;
}

describe('payment claims (PayPal.me)', () => {
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

  async function createUser(email: string, role: 'user' | 'admin' = 'user') {
    const userId = newId();
    await app.db.insert(users).values({
      id: userId,
      email,
      passwordHash: await hashSecret('irrelevant-password-123'),
      role,
      emailVerifiedAt: new Date(),
      totpEnabledAt: role === 'admin' ? new Date() : null,
    });
    if (role === 'admin') {
      await app.db
        .insert(adminUsers)
        .values({ id: newId(), userId, adminRole: 'super_admin', permissions: {} });
    }
    const token = await signAccessToken(
      { sub: userId, sid: newId(), did: null, role, plan: null, ver: 0 },
      app.config.JWT_PRIVATE_KEY!,
    );
    return { userId, token };
  }

  function submit(token: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/payment-claims',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function review(token: string, claimId: string, action: 'approve' | 'reject', reason?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/payment-claims/${claimId}/${action}`,
      headers: { authorization: `Bearer ${token}` },
      payload: action === 'reject' ? { reason } : undefined,
    });
  }

  it('a buyer submits a claim; approving it issues a 30-day Monthly pass and records the payment', async () => {
    const buyer = await createUser('buyer@example.com');
    const admin = await createUser('admin@example.com', 'admin');
    const id = txn();

    const res = await submit(buyer.token, {
      planCode: 'pro',
      paypalTransactionId: ` ${id.toLowerCase()} `,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      planCode: 'pro',
      planName: 'Monthly',
      amountCents: 999,
      paypalTransactionId: id,
      status: 'pending',
    });

    const queue = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/payment-claims?status=pending',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().items).toHaveLength(1);
    expect(queue.json().items[0].user.email).toBe('buyer@example.com');

    const approved = await review(admin.token, res.json().id, 'approve');
    expect(approved.statusCode).toBe(200);
    expect(approved.json().claim.status).toBe('approved');
    expect(approved.json().subscription).toMatchObject({ status: 'active' });
    const end = new Date(approved.json().subscription.currentPeriodEnd).getTime();
    expect(Math.abs(end - (Date.now() + 30 * DAY_MS))).toBeLessThan(60_000);

    const license = await app.db.query.licenses.findFirst({
      where: and(eq(licenses.userId, buyer.userId), eq(licenses.status, 'active')),
    });
    expect(license).toBeTruthy();

    const [payment] = await app.db.select().from(payments).where(eq(payments.userId, buyer.userId));
    expect(payment).toMatchObject({ amountCents: 999, status: 'succeeded', provider: 'manual' });

    // Approving twice never issues a second pass.
    expect((await review(admin.token, res.json().id, 'approve')).statusCode).toBe(409);
  });

  it('a pass bought during a trial replaces the trial', async () => {
    const buyer = await createUser('trialist@example.com');
    const admin = await createUser('admin2@example.com', 'admin');
    await startTrial(app.db, app.redis, {
      userId: buyer.userId,
      email: 'trialist@example.com',
      fingerprintHash: null,
      ip: null,
      stripeCustomerId: null,
    });

    const claim = await submit(buyer.token, { planCode: 'pro', paypalTransactionId: txn() });
    const approved = await review(admin.token, claim.json().id, 'approve');
    expect(approved.statusCode).toBe(200);

    const rows = await app.db.query.subscriptions.findMany({
      where: eq(subscriptions.userId, buyer.userId),
    });
    expect(rows.map((r) => r.status).sort()).toEqual(['active', 'canceled']);
    const activeLicenses = await app.db.query.licenses.findMany({
      where: and(eq(licenses.userId, buyer.userId), eq(licenses.status, 'active')),
    });
    expect(activeLicenses).toHaveLength(1);
  });

  it('a second Monthly purchase extends the pass and its license by 30 days', async () => {
    const buyer = await createUser('renewer@example.com');
    const admin = await createUser('admin3@example.com', 'admin');

    const first = await submit(buyer.token, { planCode: 'pro', paypalTransactionId: txn() });
    const firstEnd = new Date(
      (await review(admin.token, first.json().id, 'approve')).json().subscription.currentPeriodEnd,
    ).getTime();

    const second = await submit(buyer.token, { planCode: 'pro', paypalTransactionId: txn() });
    const renewed = await review(admin.token, second.json().id, 'approve');
    expect(renewed.statusCode).toBe(200);
    const secondEnd = new Date(renewed.json().subscription.currentPeriodEnd).getTime();
    expect(secondEnd - firstEnd).toBe(30 * DAY_MS);

    const license = await app.db.query.licenses.findFirst({
      where: and(eq(licenses.userId, buyer.userId), eq(licenses.status, 'active')),
    });
    expect(license?.expiresAt?.getTime()).toBe(secondEnd);
  });

  it('refuses plans that are coming soon, and a transaction ID already used', async () => {
    const buyer = await createUser('eager@example.com');
    const other = await createUser('copycat@example.com');
    const id = txn();

    expect(
      (await submit(buyer.token, { planCode: 'lifetime', paypalTransactionId: txn() })).statusCode,
    ).toBe(400);
    expect(
      (await submit(buyer.token, { planCode: 'pro', paypalTransactionId: 'not-a-paypal-id' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await submit(buyer.token, { planCode: 'pro', paypalTransactionId: id })).statusCode,
    ).toBe(201);
    expect(
      (await submit(other.token, { planCode: 'pro', paypalTransactionId: id })).statusCode,
    ).toBe(409);
  });

  it('a rejected claim shows the reason to the buyer and issues nothing', async () => {
    const buyer = await createUser('rejected@example.com');
    const admin = await createUser('admin4@example.com', 'admin');
    const claim = await submit(buyer.token, { planCode: 'pro', paypalTransactionId: txn() });

    const rejected = await review(
      admin.token,
      claim.json().id,
      'reject',
      'No payment with this ID',
    );
    expect(rejected.statusCode).toBe(200);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/payment-claims',
      headers: { authorization: `Bearer ${buyer.token}` },
    });
    expect(mine.json().items[0]).toMatchObject({
      status: 'rejected',
      rejectReason: 'No payment with this ID',
    });
    expect(
      await app.db.query.subscriptions.findMany({ where: eq(subscriptions.userId, buyer.userId) }),
    ).toHaveLength(0);
  });

  it('only admins can see or review the queue', async () => {
    const buyer = await createUser('nosy@example.com');
    const claim = await submit(buyer.token, { planCode: 'pro', paypalTransactionId: txn() });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/payment-claims',
      headers: { authorization: `Bearer ${buyer.token}` },
    });
    expect(list.statusCode).toBe(403);
    expect((await review(buyer.token, claim.json().id, 'approve')).statusCode).toBe(403);
  });
});
