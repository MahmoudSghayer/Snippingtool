// Signs a Stripe webhook payload for the subscription-via-webhook journey
// (journey d). Uses the real `stripe` SDK purely for its local, no-network
// `webhooks.generateTestHeaderString` helper — mirrors
// apps/api/src/modules/payments/__tests__/payments.test.ts's own approach
// and comment ("never a real network call... this file's local crypto
// helpers only"). The API process this suite drives is started
// (prepare.mjs) with a known STRIPE_WEBHOOK_SECRET specifically so this
// helper can sign against it.
import Stripe from 'stripe';

export const E2E_STRIPE_WEBHOOK_SECRET = 'whsec_e2e_cross_app_test_secret';

const stripe = new Stripe('sk_test_e2e_unused_no_network_calls');

/** Builds a `checkout.session.completed` event body + signature header for
 * upgrading `userId` straight to `planCode` (skips Stripe Checkout itself —
 * this journey is testing the webhook -> subscription -> dashboard path,
 * not Stripe's own hosted checkout UI, which this repo never drives in a
 * browser). Deliberately omits `mode`/`subscription` so
 * apps/api/src/modules/payments/webhooks.ts's handleCheckoutCompleted()
 * skips its `stripe.subscriptions.retrieve()` branch entirely — no real
 * Stripe API call happens anywhere in this journey. */
export function signCheckoutCompleted(
  userId: string,
  planCode: string,
): { body: string; signatureHeader: string } {
  const event = {
    id: `evt_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_e2e_${Date.now()}`,
        object: 'checkout.session',
        mode: 'payment', // not 'subscription' -> handler skips the live subscriptions.retrieve() call
        customer: `cus_e2e_${userId.slice(0, 8)}`,
        metadata: { userId, planCode },
      },
    },
  };
  const body = JSON.stringify(event);
  const signatureHeader = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: E2E_STRIPE_WEBHOOK_SECRET,
  });
  return { body, signatureHeader };
}
