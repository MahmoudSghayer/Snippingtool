// buildApp(): constructs (but does not `.listen()`) the Fastify instance.
// Used by server.ts (real boot), by every integration test (via `.inject()`),
// and by the OpenAPI generation script.
//
// Plugin order (do not reorder without checking each plugin's `dependencies`
// in its fp() options): config -> otel -> security headers -> cors -> cookie
// -> csrf -> metrics -> request-id -> db -> redis -> rate-limit -> auth ->
// websocket -> error-handler -> module autoload -> jobs (worker.ts only).

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import autoload from '@fastify/autoload';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, createJsonSchemaTransform } from 'fastify-type-provider-zod';

import { loadEnv } from './config/env.js';
import authPlugin from './plugins/auth.js';
import configPlugin from './plugins/config.js';
import cookiePlugin from './plugins/cookie.js';
import corsPlugin from './plugins/cors.js';
import csrfPlugin from './plugins/csrf.js';
import dbPlugin from './plugins/db.js';
import entitlementsPlugin from './plugins/entitlements.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import mailerPlugin from './plugins/mailer.js';
import metricsPlugin from './plugins/metrics.js';
import otelPlugin from './plugins/otel.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import redisPlugin from './plugins/redis.js';
import requestIdPlugin from './plugins/request-id.js';
import securityPlugin from './plugins/security.js';
import websocketPlugin from './plugins/websocket.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** Skip autoloading src/modules — used by tests that want a bare app plus
   * a single module registered by hand. Defaults to false. */
  skipModuleAutoload?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv();

  const app = Fastify({
    logger:
      options.logger ??
      {
        level: env.LOG_LEVEL,
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.currentPassword',
            'req.body.newPassword',
            'req.body.refreshToken',
            'req.body.token',
            'req.body.code',
            'res.headers["set-cookie"]',
            '*.password',
            '*.passwordHash',
            '*.refreshToken',
            '*.accessToken',
            '*.totpSecret',
            '*.email', // PII: emails are redacted from structured logs by default
          ],
          censor: '[redacted]',
          remove: false,
        },
      },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(configPlugin);
  await app.register(otelPlugin);
  await app.register(securityPlugin);
  await app.register(corsPlugin);
  await app.register(cookiePlugin);
  await app.register(csrfPlugin);
  await app.register(requestIdPlugin);
  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(entitlementsPlugin);
  await app.register(mailerPlugin);
  await app.register(metricsPlugin);
  await app.register(rateLimitPlugin);
  await app.register(authPlugin);
  await app.register(websocketPlugin);
  await app.register(errorHandlerPlugin);

  await app.register(import('@fastify/swagger'), {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: "The Sniper's Ledger API",
        version: '1.0.0',
        description: 'REST + WebSocket API for The Sniper\'s Ledger backend.',
      },
      servers: [{ url: env.APP_ORIGIN }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sl_at' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  if (!options.skipModuleAutoload) {
    // Each modules/<name>/ folder's index.ts is autoloaded as one plugin
    // (autoload's own rule: a directory containing an index file registers
    // *only* that file — service/repo/schema files alongside it are never
    // auto-registered separately). IMPORTANT: every module's index.ts is
    // wrapped in `fastify-plugin` (so it can reach `fastify.db`,
    // `fastify.authenticate`, etc. via the same non-encapsulated instance as
    // every other module) — and `fastify-plugin` deliberately skips the
    // encapsulation Fastify's `prefix` register-option relies on, so
    // autoload's folder-name-derived prefix (and `autoPrefix` overrides)
    // has **no effect** on an fp()-wrapped plugin. Every module therefore
    // writes the full absolute path for each route it registers
    // (`fastify.get('/api/v1/auth/login', ...)`, not `fastify.get('/login',
    // ...)` under an assumed prefix) — see apps/api/SKELETON_READY.
    await app.register(autoload, {
      dir: join(__dirname, 'modules'),
      ignorePattern: /^__tests__$|.*\.test\.(js|ts)$/,
    });
  }

  return app;
}

export { createJsonSchemaTransform };
