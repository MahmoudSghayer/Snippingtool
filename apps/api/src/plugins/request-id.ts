// Ensures every request has an `x-request-id` (reused from the incoming
// header when present, e.g. from a load balancer, so traces correlate
// end-to-end), echoes it on the response, and exposes it as `request.id`
// (Fastify already supports a custom genReqId — configured in app.ts so it
// applies before any plugin runs — this plugin just makes sure the response
// header is always set, including on early-terminated requests).

import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

export default fp(async function requestIdPlugin(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
});
