// Stripe webhook signature verification, end to end through the real HTTP
// route (POST /api/v1/webhooks/stripe): a missing or forged
// `stripe-signature` header must never reach `receiveWebhookEvent` (the
// idempotent event processor) — apps/api/src/modules/payments/index.ts
// verifies with the real `stripe.webhooks.constructEvent` before touching
// the DB. Signature-verification-*success* + idempotency + replay handling
// is already covered thoroughly at the module level
// (apps/api/src/modules/payments/__tests__, against the real Stripe SDK's
// crypto with a real signed test event) — this file is the cross-cutting
// "does the route actually enforce this, end to end, with no auth
// required to probe it" check.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, type TestApp } from './helpers.js';

describe('Stripe webhook: signature verification', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  it('rejects a request with no stripe-signature header at all (400, before any DB/Stripe work)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_fake', type: 'checkout.session.completed' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a forged/garbage stripe-signature header (400, standard error envelope — never processed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=not-a-real-signature' },
      payload: JSON.stringify({ id: 'evt_fake', type: 'checkout.session.completed', data: { object: {} } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_FAILED');
  });

  it('a forged signature never creates a stripe_webhook_events row (no partial processing on a rejected signature)', async () => {
    const before = await app.db.query.stripeWebhookEvents.findMany();
    await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=forged' },
      payload: JSON.stringify({ id: 'evt_should_not_persist', type: 'checkout.session.completed', data: { object: {} } }),
    });
    const after = await app.db.query.stripeWebhookEvents.findMany();
    expect(after.length).toBe(before.length);
  });

  it('the webhook route needs no Authorization header at all — it is publicly reachable, and correctly relies entirely on the signature, not on session auth', async () => {
    // Sanity check the route doesn't 401 before ever reaching signature
    // verification (which would defeat the point of testing the signature
    // path in isolation, and would also break real Stripe delivery, which
    // never sends a bearer token).
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});
