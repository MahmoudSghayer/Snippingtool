// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Regression coverage for defect #8 ("Defects found"): completing checkout
// (a server-to-server Stripe webhook, nothing the buyer's own open session
// did) used to invalidate the buyer's own already-issued access token.
// `modules/payments/webhooks.ts`'s `handleCheckoutCompleted()` backfills
// `users.stripe_customer_id` inside the same transaction that activates the
// subscription — a plain `users` UPDATE, which used to fire the blanket
// `bump_row_version` trigger, bumping the row_version an already-issued
// token's `ver` claim was checked against (plugins/auth.ts). Fixed by
// migrations/0026_users_row_version_exclude_billing.sql: `users` now uses
// `bump_users_row_version()`, which does not bump when the only thing that
// changed is `stripe_customer_id`.
//
// This calls `receiveWebhookEvent()` directly (bypassing Stripe signature
// verification, which tests/security and modules/payments/__tests__ already
// cover) with a minimal `checkout.session.completed` event, over a real
// register -> login -> hold-token -> webhook -> same-token-still-works
// sequence — the same repro shape as tests/e2e/specs/
// d-subscription-webhook.spec.ts's now-fixed step, but at the apps/api
// integration level (no browser, no dashboard).

import { users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { receiveWebhookEvent } from '../../../modules/payments/webhooks.js';
import { reseedPlans } from '../../reseed-reference-data.js';
import { bearer, buildTestApp, createUserSession, type TestApp } from '../helpers.js';

import type Stripe from 'stripe';

describe("checkout.session.completed does not invalidate the buyer's own pre-checkout access token (defect #8)", () => {
  let app: TestApp;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await reseedPlans(app.db);
  });

  it('the same access token still authenticates after the webhook backfills stripe_customer_id, and row_version is unchanged', async () => {
    const user = await createUserSession(
      app,
      'webhook-token-survives@example.com',
      'fp-webhook-token-000001',
    );

    const before = await app.db.query.users.findFirst({ where: eq(users.id, user.userId) });
    expect(before).toBeDefined();
    const rowVersionBefore = before!.rowVersion;

    // Sanity check: the token works before the webhook.
    const preRes = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/me',
      headers: bearer(user.accessToken),
    });
    expect(preRes.statusCode).toBe(200);

    const event = {
      id: 'evt_row_version_regression_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_row_version_regression_1',
          // Deliberately no `mode: 'subscription'` — handleCheckoutCompleted
          // only calls stripe.subscriptions.retrieve() in that branch, and
          // this test doesn't need a fake Stripe client for it.
          amount_total: 999,
          currency: 'usd',
          customer: 'cus_row_version_regression_1',
          metadata: { userId: user.userId, planCode: 'pro', couponId: '', couponCode: '' },
        },
      },
    } as unknown as Stripe.Event;

    const result = await receiveWebhookEvent(app.db, app.redis, {} as unknown as Stripe, event);
    expect(result.alreadyProcessed).toBe(false);

    const after = await app.db.query.users.findFirst({ where: eq(users.id, user.userId) });
    expect(after!.stripeCustomerId).toBe('cus_row_version_regression_1'); // the backfill did happen
    expect(after!.rowVersion).toBe(rowVersionBefore); // ...but it did not bump row_version

    // The pre-checkout access token still works — no 401, no forced re-login.
    const postRes = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/me',
      headers: bearer(user.accessToken),
    });
    expect(postRes.statusCode).toBe(200);
    const body = postRes.json() as {
      subscription: { status: string; plan: { code: string } } | null;
    };
    expect(body.subscription?.status).toBe('active');
    expect(body.subscription?.plan.code).toBe('pro');
  });

  it('a genuinely security-relevant users UPDATE (password change) still invalidates the token, unaffected by this fix', async () => {
    const user = await createUserSession(
      app,
      'webhook-security-still-bumps@example.com',
      'fp-webhook-security-0001',
    );

    const changeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: bearer(user.accessToken),
      payload: {
        currentPassword: 'correcthorsebattery12',
        newPassword: 'a-new-correct-horse-battery-12',
      },
    });
    expect(changeRes.statusCode).toBe(200);

    // The now-stale access token (issued before the password change) must
    // still be rejected — this fix only excludes stripe_customer_id, never
    // password_hash.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/subscriptions/me',
      headers: bearer(user.accessToken),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
  });
});
