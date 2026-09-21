// POST /payments/checkout, POST /payments/portal, GET /payments/history,
// and POST /webhooks/stripe (raw body, signature-verified, idempotent).

import { users } from '@sl/db';
import {
  billingPortalResponseSchema,
  checkoutRequestSchema,
  checkoutResponseSchema,
  paginatedResponseSchema,
  paginationQuerySchema,
  paymentDtoSchema,
} from '@sl/shared';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppErrors } from '../../lib/errors.js';

import { createCheckoutSession, createPortalSession, listPaymentHistory, type PaymentRow } from './service.js';
import { getStripeClient } from './stripe-client.js';
import { getStripeConfig } from './stripe-config.js';
import { receiveWebhookEvent } from './webhooks.js';

import type { FastifyInstance } from 'fastify';

// Open-redirect guard (docs/09-security.md "Open redirect"): `successUrl`/
// `cancelUrl`/`returnUrl` are caller-supplied (Stripe Checkout/Portal's own
// API contract requires the caller to pass them), so without this check a
// forged request could hand back an attacker-controlled `checkoutUrl` for
// the dashboard's own JS to `window.location`-redirect to (the free-coupon
// path in particular echoes `successUrl` straight back — see below). Every
// redirect target this module accepts must therefore start with the
// configured dashboard origin; nothing here ever needs to redirect anywhere
// else. `preHandler: [fastify.verifyCsrf]` (added to both routes below)
// closes the CSRF half of this same risk; this closes the "even a same-site
// same-user call" half.
function assertDashboardOrigin(fastify: FastifyInstance, url: string, field: string): void {
  const dashboardOrigin = fastify.config.DASHBOARD_ORIGIN;
  if (!url.startsWith(dashboardOrigin)) {
    throw AppErrors.validation(`${field} must start with the configured dashboard origin.`, { field, dashboardOrigin });
  }
}

function toPaymentDto(row: PaymentRow) {
  return {
    id: row.id,
    provider: row.provider,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status,
    invoiceUrl: row.invoiceUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

export default fp(
  async function paymentsModule(fastify: FastifyInstance) {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/api/v1/payments/checkout',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['payments'],
          summary: 'Create a Stripe Checkout session for a plan (coupon code optional).',
          body: checkoutRequestSchema,
          response: { 200: checkoutResponseSchema },
        },
      },
      async (request) => {
        assertDashboardOrigin(fastify, request.body.successUrl, 'successUrl');
        assertDashboardOrigin(fastify, request.body.cancelUrl, 'cancelUrl');

        const user = await fastify.db.query.users.findFirst({ where: eq(users.id, request.authUser!.id) });
        if (!user) throw AppErrors.notFound('user');

        const stripe = getStripeClient(fastify.config);
        const config = getStripeConfig(fastify.config);

        const result = await createCheckoutSession(stripe, fastify.db, fastify.redis, config, {
          userId: request.authUser!.id,
          email: user.email,
          planCode: request.body.planCode,
          successUrl: request.body.successUrl,
          cancelUrl: request.body.cancelUrl,
          couponCode: request.body.couponCode,
        });

        // A free_days/lifetime coupon grants the subscription instantly with
        // no Stripe round trip (docs/05-subscriptions.md §8) — the client
        // still expects a URL to redirect to, so it gets the caller's own
        // successUrl, exactly as if a real Checkout session had completed.
        return { checkoutUrl: result.kind === 'checkout' ? result.checkoutUrl : request.body.successUrl };
      },
    );

    app.post(
      '/api/v1/payments/portal',
      {
        onRequest: [fastify.authenticate],
        preHandler: [fastify.verifyCsrf],
        schema: {
          tags: ['payments'],
          summary: 'Create a Stripe Customer Portal session.',
          body: z.object({ returnUrl: z.string().url() }),
          response: { 200: billingPortalResponseSchema },
        },
      },
      async (request) => {
        assertDashboardOrigin(fastify, request.body.returnUrl, 'returnUrl');

        const user = await fastify.db.query.users.findFirst({ where: eq(users.id, request.authUser!.id) });
        if (!user) throw AppErrors.notFound('user');

        const stripe = getStripeClient(fastify.config);
        return createPortalSession(stripe, fastify.db, {
          userId: user.id,
          email: user.email,
          stripeCustomerId: user.stripeCustomerId,
          returnUrl: request.body.returnUrl,
        });
      },
    );

    app.get(
      '/api/v1/payments/history',
      {
        onRequest: [fastify.authenticate],
        schema: {
          tags: ['payments'],
          summary: "Current user's payment history, cursor-paginated.",
          querystring: paginationQuerySchema,
          response: { 200: paginatedResponseSchema(paymentDtoSchema) },
        },
      },
      async (request) => {
        const page = await listPaymentHistory(fastify.db, request.authUser!.id, request.query.limit, request.query.cursor);
        return { items: page.items.map(toPaymentDto), nextCursor: page.nextCursor };
      },
    );

    // Raw-body scope: Stripe signature verification needs the exact bytes
    // Stripe signed, so this route's content-type parser is overridden to
    // hand back a Buffer instead of the app-wide parsed JSON — scoped to
    // this one nested `register()` context (no `fastify-plugin` wrapper
    // here, deliberately, so the override does not leak to sibling routes
    // or other modules; `app.ts`'s global JSON parsing is untouched).
    await fastify.register(async function stripeWebhookScope(scoped) {
      scoped.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
        done(null, body);
      });

      scoped.post(
        '/api/v1/webhooks/stripe',
        {
          schema: {
            tags: ['payments'],
            summary: 'Stripe webhook receiver — signature-verified, idempotent.',
            response: { 200: z.object({ received: z.boolean() }), 400: z.object({ received: z.boolean() }) },
          },
        },
        async (request, reply) => {
          const signature = request.headers['stripe-signature'];
          if (!signature || typeof signature !== 'string') {
            throw AppErrors.validation('Missing stripe-signature header.');
          }

          const stripe = getStripeClient(fastify.config);
          const config = getStripeConfig(fastify.config);

          let event;
          try {
            event = stripe.webhooks.constructEvent(request.body as Buffer, signature, config.webhookSecret);
          } catch (err) {
            fastify.log.warn({ err }, 'stripe webhook signature verification failed');
            return reply.status(400).send({ received: false });
          }

          await receiveWebhookEvent(fastify.db, fastify.redis, stripe, event);
          return { received: true };
        },
      );
    });
  },
  { name: 'module:payments', dependencies: ['auth', 'db', 'redis'] },
);
