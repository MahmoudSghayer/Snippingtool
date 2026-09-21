// Decorates `fastify.entitlements` with the default EntitlementProvider
// (src/lib/entitlements.ts). The subscriptions/payments agent may replace
// this decoration (redecorate is not allowed by Fastify once set within the
// same encapsulation context, so if they need a richer implementation they
// should either extend DefaultEntitlementProvider or register their own
// child-scoped override inside their module) — modules/extension only ever
// depends on the `EntitlementProvider` interface, never this concrete class.

import fp from 'fastify-plugin';

import { DefaultEntitlementProvider, type EntitlementProvider } from '../lib/entitlements.js';

import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    entitlements: EntitlementProvider;
  }
}

export default fp(
  async function entitlementsPlugin(fastify: FastifyInstance) {
    fastify.decorate(
      'entitlements',
      new DefaultEntitlementProvider(fastify.db, fastify.config.ENTITLEMENT_SIGNING_KEY),
    );
  },
  { name: 'entitlements', dependencies: ['config', 'db'] },
);
