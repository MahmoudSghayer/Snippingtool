// Optional OpenTelemetry traces. When OTEL_EXPORTER_OTLP_ENDPOINT is unset
// (the default for local dev/test), this plugin is a no-op — tracing is
// opt-in infra, never required to boot the app.

import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

export default fp(
  async function otelPlugin(fastify: FastifyInstance) {
    const endpoint = fastify.config.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) {
      fastify.log.debug('OTEL_EXPORTER_OTLP_ENDPOINT not set; tracing disabled.');
      return;
    }

    try {
      const { NodeSDK } = await import('@opentelemetry/sdk-node');
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');

      const sdk = new NodeSDK({
        traceExporter: new OTLPTraceExporter({ url: endpoint }),
        instrumentations: [getNodeAutoInstrumentations()],
      });
      sdk.start();
      fastify.addHook('onClose', async () => {
        await sdk.shutdown();
      });
      fastify.log.info({ endpoint }, 'OpenTelemetry tracing enabled');
    } catch (err) {
      fastify.log.warn({ err }, 'OTEL packages not installed; tracing disabled. Add @opentelemetry/* deps to enable.');
    }
  },
  { name: 'otel', dependencies: ['config'] },
);
