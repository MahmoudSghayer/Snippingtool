// CORS allowlist: DASHBOARD_ORIGIN (cookie-session dashboard), any further
// origins in EXTRA_CORS_ORIGINS (for a second dashboard deployment — the
// self-hosted one alongside Vercel, say), plus every chrome-extension://<id>
// origin listed in EXTENSION_IDS (comma-separated ids, with or without the
// chrome-extension:// scheme — both forms accepted so the env var can be
// edited either way without a footgun).

import cors from '@fastify/cors';
import fp from 'fastify-plugin';

import type { FastifyInstance } from 'fastify';

function splitOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function extensionOrigins(extensionIds: string): string[] {
  return extensionIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => (id.startsWith('chrome-extension://') ? id : `chrome-extension://${id}`));
}

export default fp(
  async function corsPlugin(fastify: FastifyInstance) {
    const allowlist = new Set([
      fastify.config.DASHBOARD_ORIGIN,
      ...splitOrigins(fastify.config.EXTRA_CORS_ORIGINS),
      ...extensionOrigins(fastify.config.EXTENSION_IDS),
    ]);

    await fastify.register(cors, {
      origin(origin, callback) {
        // Same-origin / non-browser requests (curl, server-to-server) send no
        // Origin header — allow those through; the browser is what enforces
        // CORS for cross-origin requests, so this only gates browser callers.
        if (!origin || allowlist.has(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not allowed'), false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'x-request-id'],
      exposedHeaders: ['x-request-id'],
    });
  },
  { name: 'cors', dependencies: ['config'] },
);
