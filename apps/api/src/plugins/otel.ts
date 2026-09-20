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
      // Imported via variables (not string literals) so this stays a pure
      // *runtime* optional dependency: TypeScript cannot statically resolve
      // a non-literal specifier, so no @opentelemetry/* type packages need
      // to be installed just to typecheck this file.
      const sdkModule = '@opentelemetry/sdk-node';
      const traceExporterModule = '@opentelemetry/exporter-trace-otlp-http';
      const autoInstrumentationsModule = '@opentelemetry/auto-instrumentations-node';

      const { NodeSDK } = (await import(sdkModule)) as { NodeSDK: new (opts: Record<string, unknown>) => { start: () => void; shutdown: () => Promise<void> } };
      const { OTLPTraceExporter } = (await import(traceExporterModule)) as { OTLPTraceExporter: new (opts: Record<string, unknown>) => unknown };
      const { getNodeAutoInstrumentations } = (await import(autoInstrumentationsModule)) as { getNodeAutoInstrumentations: () => unknown[] };

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
