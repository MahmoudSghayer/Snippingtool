// Tells the operator's Discord channel about a PayPal payment a customer has
// just submitted, so it gets checked and approved quickly: the pass only
// starts on approval, and the refund window is 24 hours. Enqueued by
// modules/payment-claims when a claim is created; a no-op when
// PAYMENTS_DISCORD_WEBHOOK_URL is unset.

import { paymentClaims, plans, users } from '@sl/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { clip, postDiscordWebhook, type DiscordMessage } from '../lib/discord.js';

import { defineJob } from './types.js';

export const PAYMENTS_NOTIFY_JOB = 'payments.notify';

const dataSchema = z.object({ claimId: z.string().uuid() });
export type PaymentsNotifyData = z.infer<typeof dataSchema>;

const GOLD = 0xe0b04a;

export function buildPaymentClaimMessage(input: {
  claimId: string;
  email: string;
  planName: string;
  amountCents: number;
  currency: string;
  paypalTransactionId: string;
  note: string | null;
  submittedAt: Date;
  dashboardOrigin: string;
}): DiscordMessage {
  const amount = `${(input.amountCents / 100).toFixed(2)} ${input.currency.toUpperCase()}`;
  const fields = [
    { name: 'Plan', value: clip(input.planName), inline: true },
    { name: 'Amount', value: amount, inline: true },
    { name: 'Customer', value: clip(input.email), inline: false },
    { name: 'PayPal transaction ID', value: `\`${input.paypalTransactionId}\``, inline: false },
  ];
  if (input.note)
    fields.push({ name: 'Note from customer', value: clip(input.note), inline: false });

  return {
    embeds: [
      {
        title: 'New PayPal payment to review',
        url: `${input.dashboardOrigin.replace(/\/+$/, '')}/admin/payments`,
        description:
          'Find this transaction ID and amount in PayPal, then approve or reject it in the admin Payments page.',
        color: GOLD,
        fields,
        timestamp: input.submittedAt.toISOString(),
      },
    ],
  };
}

export default defineJob<PaymentsNotifyData>({
  name: PAYMENTS_NOTIFY_JOB,
  concurrency: 2,
  async processor(job, { db, env, log }) {
    const webhookUrl = env.PAYMENTS_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      log.info({ job: job.id }, 'payments.notify: PAYMENTS_DISCORD_WEBHOOK_URL unset, skipping');
      return;
    }
    const { claimId } = dataSchema.parse(job.data);

    const [row] = await db
      .select({
        claim: paymentClaims,
        email: users.email,
        planName: plans.name,
      })
      .from(paymentClaims)
      .innerJoin(users, eq(users.id, paymentClaims.userId))
      .leftJoin(plans, eq(plans.code, paymentClaims.planCode))
      .where(eq(paymentClaims.id, claimId))
      .limit(1);
    if (!row) {
      log.warn({ claimId }, 'payments.notify: claim not found, skipping');
      return;
    }

    await postDiscordWebhook(
      webhookUrl,
      buildPaymentClaimMessage({
        claimId,
        email: row.email,
        planName: row.planName ?? row.claim.planCode,
        amountCents: row.claim.amountCents,
        currency: row.claim.currency,
        paypalTransactionId: row.claim.paypalTransactionId,
        note: row.claim.note,
        submittedAt: row.claim.createdAt,
        dashboardOrigin: env.DASHBOARD_ORIGIN,
      }),
    );
    log.info({ claimId }, 'payments.notify: posted to Discord');
  },
});
