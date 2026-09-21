// Journey (d): subscription activated via a Stripe webhook (real signature,
// generated for this run's own STRIPE_WEBHOOK_SECRET — see
// helpers/stripe.ts) -> the dashboard, logged in as that user, shows the
// new plan on /subscriptions.
import { expect, test } from '@playwright/test';

import { TEST_PASSWORD, registerAndLogin } from '../helpers/auth.js';
import { connect, deleteUsersByEmailPrefix } from '../helpers/db.js';
import { signCheckoutCompleted } from '../helpers/stripe.js';
import { API_ORIGIN, DASHBOARD_PORT } from '../playwright.config.js';

const EMAIL = `e2e-journey-d-${Date.now()}@example.com`;
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;

test.afterAll(async () => {
  const db = connect();
  try {
    await deleteUsersByEmailPrefix(db, 'e2e-journey-d-');
  } finally {
    await db.end({ timeout: 5 });
  }
});

test('checkout.session.completed webhook activates a plan -> dashboard shows it', async ({ page, request }) => {
  const user = await test.step('user registers, verifies, logs in (API) — starts with no subscription', () => registerAndLogin(API_ORIGIN, EMAIL, 'journey-d'));

  await test.step('GET /subscriptions/me shows no live subscription yet', async () => {
    const res = await request.get(`${API_ORIGIN}/api/v1/subscriptions/me`, { headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { subscription: unknown };
    expect(body.subscription).toBeNull();
  });

  await test.step('a signed checkout.session.completed webhook activates the pro plan', async () => {
    const { body, signatureHeader } = signCheckoutCompleted(user.userId, 'pro');
    const res = await request.post(`${API_ORIGIN}/api/v1/webhooks/stripe`, {
      headers: { 'content-type': 'application/json', 'stripe-signature': signatureHeader },
      data: body,
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()) as { received: boolean }).toEqual({ received: true });
  });

  // --- Defect #8 (docs/12-testing.md "Defects found") — FIXED ---
  //
  // apps/api/src/modules/payments/webhooks.ts's handleCheckoutCompleted()
  // backfills `users.stripe_customer_id` in the same transaction that
  // activates the subscription. That used to fire the blanket
  // `bump_row_version` trigger on `users` — including for this write,
  // which has nothing to do with the caller's own session — so the access
  // token the buyer was already holding (issued with `ver` = the
  // row_version at login time) went stale the instant the webhook landed,
  // and their very next authenticated request 401'd with
  // AUTH_SESSION_REVOKED. Fixed by migrations/0026_users_row_version_
  // exclude_billing.sql: `users` now has its own trigger,
  // `bump_users_row_version()`, which skips the bump when the only column
  // that changed is `stripe_customer_id` — this is the regression test for
  // that fix, over real HTTP against the real trigger.
  await test.step("the buyer's own pre-checkout access token still works after the webhook's stripe_customer_id backfill", async () => {
    const res = await request.get(`${API_ORIGIN}/api/v1/subscriptions/me`, { headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { subscription: { status: string } };
    expect(body.subscription.status).toBe('active');
  });

  await test.step('a replayed copy of the same event (same event id + signature) is a safe no-op (idempotency)', async () => {
    const replay = signCheckoutCompleted(user.userId, 'pro');
    const res1 = await request.post(`${API_ORIGIN}/api/v1/webhooks/stripe`, {
      headers: { 'content-type': 'application/json', 'stripe-signature': replay.signatureHeader },
      data: replay.body,
    });
    expect(res1.status()).toBe(200);
    const res2 = await request.post(`${API_ORIGIN}/api/v1/webhooks/stripe`, {
      headers: { 'content-type': 'application/json', 'stripe-signature': replay.signatureHeader },
      data: replay.body,
    });
    expect(res2.status()).toBe(200); // stripe_webhook_events unique(event_id) — second delivery is a no-op, not an error
  });

  await test.step('the API now shows the pro plan active', async () => {
    const res = await request.get(`${API_ORIGIN}/api/v1/subscriptions/me`, { headers: { authorization: `Bearer ${user.accessToken}` } });
    const body = (await res.json()) as { subscription: { status: string; plan: { code: string; name: string } } };
    expect(body.subscription.status).toBe('active');
    expect(body.subscription.plan.code).toBe('pro');
  });

  await test.step('an invalid signature is rejected (400), never processed', async () => {
    const { body } = signCheckoutCompleted(user.userId, 'ultimate');
    const res = await request.post(`${API_ORIGIN}/api/v1/webhooks/stripe`, {
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=not_a_real_signature' },
      data: body,
    });
    expect(res.status()).toBe(400);
    // Confirms the bad-signature attempt above did not sneak the user onto
    // 'ultimate' — still 'pro' from the legitimately-signed event.
    const check = await request.get(`${API_ORIGIN}/api/v1/subscriptions/me`, { headers: { authorization: `Bearer ${user.accessToken}` } });
    const checkBody = (await check.json()) as { subscription: { plan: { code: string } } };
    expect(checkBody.subscription.plan.code).toBe('pro');
  });

  await test.step('dashboard (logged in as this user, real cookie session) shows the Pro plan on /subscriptions', async () => {
    await page.goto(`${DASHBOARD_ORIGIN}/login`);
    await page.getByLabel('Email').fill(EMAIL);
    // exact: true — apps/dashboard's PasswordInput also renders a
    // `<button aria-label="Show password">` next to the field, and
    // `getByLabel` substring-matches by default, so plain
    // `getByLabel('Password')` resolves to 2 elements (reproduced while
    // authoring this spec).
    await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
    await page.getByLabel('This device').fill('e2e journey d browser');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.goto(`${DASHBOARD_ORIGIN}/subscriptions`);
    await expect(page.getByText('Pro', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  });
});
