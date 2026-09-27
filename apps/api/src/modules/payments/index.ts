// GET /payments/history — the signed-in user's recorded payments (one row per
// approved PayPal payment claim).

import { paginatedResponseSchema, paginationQuerySchema, paymentDtoSchema } from '@sl/shared';
import fp from 'fastify-plugin';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';

import { listPaymentHistory, type PaymentRow } from './service.js';

import type { FastifyInstance } from 'fastify';

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
        const page = await listPaymentHistory(
          fastify.db,
          request.authUser!.id,
          request.query.limit,
          request.query.cursor,
        );
        return { items: page.items.map(toPaymentDto), nextCursor: page.nextCursor };
      },
    );
  },
  { name: 'module:payments', dependencies: ['auth', 'db'] },
);
