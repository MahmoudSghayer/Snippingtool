// Nightly: re-syncs every local Stripe-sourced live subscription directly
// from Stripe (docs/05-subscriptions.md §9) — the correctness backstop for
// any webhook that was missed, delivered out of order, or failed. Also
// re-attempts any `stripe_webhook_events` row that was received but never
// finished processing (`processed_at IS NULL`) before the reconciliation
// pass, so a transient failure in a handler gets a second chance.

import { stripeWebhookEvents } from '@sl/db';
import { isNull } from 'drizzle-orm';

import { reconcileStripeSubscriptions } from '../modules/payments/service.js';
import { getStripeClient } from '../modules/payments/stripe-client.js';
import { receiveWebhookEvent } from '../modules/payments/webhooks.js';

import { defineJob } from './types.js';

import type Stripe from 'stripe';

export default defineJob({
  name: 'stripe.reconcile',
  schedule: '0 4 * * *', // 04:00 UTC nightly, after licenses.revalidate
  async processor(_job, { db, redis, log }) {
    let stripe;
    try {
      stripe = getStripeClient(process.env);
    } catch (err) {
      log.warn({ err }, 'stripe.reconcile: Stripe is not configured, skipping run');
      return;
    }

    const unprocessed = await db.query.stripeWebhookEvents.findMany({
      where: isNull(stripeWebhookEvents.processedAt),
    });
    let retried = 0;
    for (const row of unprocessed) {
      try {
        // stripeWebhookEvents.payload was stored from a real, already
        // signature-verified Stripe.Event at receipt time — re-processing
        // it here does not need a second signature check.
        await receiveWebhookEvent(db, redis, stripe, row.payload as unknown as Stripe.Event);
        retried += 1;
      } catch (err) {
        log.warn(
          { err, eventId: row.eventId },
          'stripe.reconcile: retry of unprocessed webhook event failed again',
        );
      }
    }

    const { reconciledCount, errorCount } = await reconcileStripeSubscriptions(db, redis, stripe);
    log.info(
      { retriedWebhooks: retried, reconciledCount, errorCount },
      'stripe.reconcile completed',
    );
  },
});
