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

  // --- Defect found: completing checkout invalidates the buyer's own
  // already-open session ---
  //
  // apps/api/src/modules/payments/webhooks.ts's handleCheckoutCompleted()
  // backfills `users.stripe_customer_id` in the same transaction that
  // activates the subscription (`if (stripeCustomerId) { await
  // tx.update(users).set({ stripeCustomerId })... }`, its own comment: "the
  // first point a Stripe Customer exists ... persist it"). Every UPDATE to
  // `users` fires the blanket `bump_row_version` trigger — including this
  // one, which has nothing to do with the *caller's own* session — so the
  // access token this same user was holding before checkout (issued with
  // `ver` = the row_version at login time) goes stale the instant the
  // webhook lands, and their very next authenticated request 401s with
  // AUTH_SESSION_REVOKED. Reproduced directly (register -> login -> hold
  // the access token -> checkout webhook -> same token immediately 401s)
  // while authoring this journey. This is the same root cause pattern as
  // `apps/api/src/test/qa/__tests__/settings-versioning.test.ts`'s
  // documented defect: a benign, unrelated `users` UPDATE incidentally
  // invalidating a live session via the blanket per-row trigger. Proposed
  // fix: don't route the `stripe_customer_id` backfill through a plain
  // `users` UPDATE inside this transaction — either bump `row_version`
  // explicitly to the *pre-checkout* value afterwards (defeats the
  // trigger's purpose elsewhere), or move `stripe_customer_id` off `users`
  // onto a column/table the row-version-invalidation trigger doesn't cover
  // — not applied here, this suite never edits application source. In
  // practice a real client's access token is short-lived (15 min) and its
  // `lib/api.ts`/dashboard API client both auto-refresh on a 401, so the
  // user experience is "one extra silent network round trip", not a
  // visible break — but it is real, and worth knowing about before
  // assuming a 401 right after checkout is a caller bug.
  await test.step("DEFECT: the buyer's own pre-checkout access token is immediately invalidated by the webhook's stripe_customer_id backfill", async () => {
    const res = await request.get(`${API_ORIGIN}/api/v1/subscriptions/me`, { headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(res.status()).toBe(401);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });

    // A real client recovers via its normal 401 -> refresh flow — confirm
    // that recovery actually works, so this defect is "an extra round
    // trip", not "the user is locked out".
    const refreshed = await request.post(`${API_ORIGIN}/api/v1/auth/refresh`, { data: { refreshToken: user.refreshToken } });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    const refreshedBody = (await refreshed.json()) as { accessToken: string; refreshToken: string };
    user.accessToken = refreshedBody.accessToken;
    user.refreshToken = refreshedBody.refreshToken;
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
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByLabel('This device').fill('e2e journey d browser');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.goto(`${DASHBOARD_ORIGIN}/subscriptions`);
    await expect(page.getByText('Pro', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  });
});
