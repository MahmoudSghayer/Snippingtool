// Real-client factory. Every `modules/payments`/`admin-*` service function
// that talks to Stripe takes a `Stripe` instance as an explicit parameter
// (never reads a module-level singleton itself) specifically so tests can
// pass a fake/mocked object satisfying the same shape instead of calling
// this factory at all — see docs/05-subscriptions.md and this module's
// `__tests__/` for the pattern. This factory exists only for the real route
// handlers in `index.ts` to obtain the one real client, cached per process.

import Stripe from 'stripe';

import { getStripeConfig, type StripeEnvSource } from './stripe-config.js';

let cached: Stripe | undefined;

export function getStripeClient(env: StripeEnvSource): Stripe {
  if (cached) return cached;
  const config = getStripeConfig(env);
  cached = new Stripe(config.secretKey, { typescript: true });
  return cached;
}

/** Test-only: clears the cached client so a test that swaps env vars (or
 * wants a fresh instance) doesn't get a stale one. Never called from
 * production code paths. */
export function resetStripeClientForTests(): void {
  cached = undefined;
}
