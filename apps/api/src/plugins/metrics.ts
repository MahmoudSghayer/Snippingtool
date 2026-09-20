// prom-client default + custom metrics, exposed at GET /metrics (unauthenticated
// — put behind network/infra access control in production, per docs/03-api.md).

import fp from 'fastify-plugin';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: {
      registry: Registry;
      httpRequests: Counter<string>;
      httpDuration: Histogram<string>;
    };
  }
}

export default fp(
  async function metricsPlugin(fastify: FastifyInstance) {
    const registry = new Registry();
    collectDefaultMetrics({ register: registry });

    const httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    });

    const httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    });

    fastify.decorate('metrics', { registry, httpRequests, httpDuration });

    fastify.addHook('onRequest', async (request) => {
      (request as unknown as { _metricsStart: number })._metricsStart = performance.now();
    });

    fastify.addHook('onResponse', async (request, reply) => {
      const start = (request as unknown as { _metricsStart?: number })._metricsStart;
      const route = request.routeOptions?.url ?? request.url;
      const labels = { method: request.method, route, status: String(reply.statusCode) };
      httpRequests.inc(labels);
      if (start) httpDuration.observe(labels, (performance.now() - start) / 1000);
    });

    fastify.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
      reply.header('content-type', registry.contentType);
      return registry.metrics();
    });
  },
  { name: 'metrics' },
);
