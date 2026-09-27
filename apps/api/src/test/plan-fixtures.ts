// Gives a test user a subscription, so a test that calls a feature-gated
// route (plugins/auth.ts `requireFeature`) can do so as a user with a real
// plan rather than one with none. Paid plans go through the same
// `activateManual` an admin grant uses; a trial is inserted as the
// `trialing` row `startTrial` would write, without its abuse checks (which
// look at IPs and devices these fixtures don't have).
//
// Call after `resetDatabase()`: it reseeds the plan rows itself.

import { subscriptions } from '@sl/db';
import { TRIAL_LENGTH_DAYS, type PlanCode } from '@sl/shared';
import { eq } from 'drizzle-orm';

import { newId } from '../lib/ids.js';
import { activateManual, getPlanByCode } from '../modules/subscriptions/service.js';

import { reseedPlans } from './reseed-reference-data.js';

import type { FastifyInstance } from 'fastify';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function grantPlan(
  app: FastifyInstance,
  userId: string,
  planCode: PlanCode = 'pro',
): Promise<{ subscriptionId: string }> {
  await reseedPlans(app.db);
  if (planCode !== 'trial') {
    const { subscription } = await activateManual(app.db, app.redis, {
      userId,
      planCode,
      periodDays: 30,
      grantedByAdminId: null,
    });
    return { subscriptionId: subscription.id };
  }
  const plan = await getPlanByCode(app.db, 'trial');
  const now = new Date();
  const id = newId();
  await app.db.insert(subscriptions).values({
    id,
    userId,
    planId: plan!.id,
    status: 'trialing',
    currentPeriodStart: now,
    currentPeriodEnd: null,
    trialEndsAt: new Date(now.getTime() + TRIAL_LENGTH_DAYS * DAY_MS),
    cancelAtPeriodEnd: false,
    autoRenew: false,
    source: 'manual',
  });
  return { subscriptionId: id };
}

/** A user whose `planCode` pass has run out: the row the
 * `subscriptions.expire` job leaves behind. Written straight to the table,
 * so call it before the user's first gated request (nothing is cached yet). */
export async function grantExpiredPlan(
  app: FastifyInstance,
  userId: string,
  planCode: PlanCode = 'pro',
): Promise<void> {
  const { subscriptionId } = await grantPlan(app, userId, planCode);
  await app.db
    .update(subscriptions)
    .set({ status: 'expired', endedAt: new Date(), trialEndsAt: null })
    .where(eq(subscriptions.id, subscriptionId));
}
