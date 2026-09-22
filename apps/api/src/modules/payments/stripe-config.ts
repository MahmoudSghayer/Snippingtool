// A small, self-validated view of the Stripe env vars — per the task brief,
// this module reads `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/
// `STRIPE_PRICE_*` via its own zod-validated `getStripeConfig()` rather than
// assuming any particular shape of `fastify.config`, even though the core
// agent's `config/env.ts` already declares these same vars (optional, for
// this module's benefit — see `apps/api/SKELETON_READY`). This keeps
// `modules/payments` fully self-contained: it would work unchanged if a
// future refactor moved Stripe config out of the shared env schema.

import { z } from 'zod';

import { AppErrors } from '../../lib/errors.js';

const stripeConfigSchema = z.object({
  secretKey: z.string().min(1),
  webhookSecret: z.string().min(1),
  priceIds: z.object({
    basic: z.string().min(1),
    pro: z.string().min(1),
    ultimate: z.string().min(1),
    lifetime: z.string().min(1),
  }),
});
export type StripeConfig = z.infer<typeof stripeConfigSchema>;

export interface StripeEnvSource {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_BASIC?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_ULTIMATE?: string;
  STRIPE_PRICE_LIFETIME?: string;
}

/** Throws a clear `INTERNAL` `AppError` (never a raw zod error) naming
 * exactly which var is missing — this is only called from routes that
 * genuinely need Stripe (checkout/portal/webhook), so a dev/test process
 * with no Stripe keys configured at all still boots and serves every other
 * route fine. */
export function getStripeConfig(env: StripeEnvSource): StripeConfig {
  const parsed = stripeConfigSchema.safeParse({
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    priceIds: {
      basic: env.STRIPE_PRICE_BASIC,
      pro: env.STRIPE_PRICE_PRO,
      ultimate: env.STRIPE_PRICE_ULTIMATE,
      lifetime: env.STRIPE_PRICE_LIFETIME,
    },
  });
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw AppErrors.internal(`Stripe is not configured (missing: ${missing}).`);
  }
  return parsed.data;
}
