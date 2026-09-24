// payments.notify: a submitted PayPal payment is posted to the operator's
// Discord channel, and submitting one enqueues the job.

import { paymentClaims, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../app.js';
import { hashSecret } from '../../lib/crypto.js';
import { newId } from '../../lib/ids.js';
import { signAccessToken } from '../../lib/tokens.js';
import { reseedPlans } from '../../test/reseed-reference-data.js';
import paymentsNotifyJob, {
  buildPaymentClaimMessage,
  PAYMENTS_NOTIFY_JOB,
} from '../payments.notify.job.js';

import type { JobContext } from '../types.js';
import type { Job } from 'bullmq';
import type { FastifyInstance } from 'fastify';

const noopLog: JobContext['log'] = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const WEBHOOK = 'https://discord.example/api/webhooks/1/abc';

describe('payments.notify', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    await reseedPlans(app.db);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ctx(webhook: string | undefined): JobContext {
    return {
      db: app.db,
      redis: app.redis,
      env: { ...app.config, PAYMENTS_DISCORD_WEBHOOK_URL: webhook },
      mailer: app.mailer,
      log: noopLog,
    };
  }

  async function createClaim(note: string | null = null) {
    const userId = newId();
    await app.db.insert(users).values({
      id: userId,
      email: 'payer@example.com',
      passwordHash: await hashSecret('irrelevant-password-123'),
      emailVerifiedAt: new Date(),
    });
    const [claim] = await app.db
      .insert(paymentClaims)
      .values({
        id: newId(),
        userId,
        planCode: 'pro',
        amountCents: 999,
        paypalTransactionId: '8XY12345AB678901C',
        note,
      })
      .returning();
    return { userId, claim: claim! };
  }

  const run = (context: JobContext, claimId: string) =>
    paymentsNotifyJob.processor(
      { id: '1', data: { claimId } } as Job<{ claimId: string }>,
      context,
    );

  it('posts the claim to Discord with a link to the admin queue', async () => {
    const { claim } = await createClaim('paid from my brother@example.com account');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await run(ctx(WEBHOOK), claim.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    const body = JSON.parse(init.body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const embed = body.embeds[0];
    expect(embed.url).toBe(`${app.config.DASHBOARD_ORIGIN.replace(/\/+$/, '')}/admin/payments`);
    const text = JSON.stringify(embed.fields);
    expect(text).toContain('Monthly');
    expect(text).toContain('9.99 USD');
    expect(text).toContain('payer@example.com');
    expect(text).toContain('8XY12345AB678901C');
    expect(text).toContain('brother@example.com');
  });

  it('does nothing when no webhook is configured', async () => {
    const { claim } = await createClaim();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await run(ctx(undefined), claim.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails (so BullMQ retries) when Discord refuses the message', async () => {
    const { claim } = await createClaim();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })));

    await expect(run(ctx(WEBHOOK), claim.id)).rejects.toThrow('429');
  });

  it('clips a long customer note to what Discord accepts', () => {
    const message = buildPaymentClaimMessage({
      claimId: newId(),
      email: 'a@example.com',
      planName: 'Monthly',
      amountCents: 999,
      currency: 'usd',
      paypalTransactionId: '8XY12345AB678901C',
      note: 'x'.repeat(5000),
      submittedAt: new Date(),
      dashboardOrigin: 'https://example.test/',
    });
    const note = message.embeds![0]!.fields!.find((f) => f.name === 'Note from customer')!;
    expect(note.value.length).toBeLessThanOrEqual(1024);
  });

  it('submitting a payment enqueues the notification', async () => {
    const userId = newId();
    await app.db.insert(users).values({
      id: userId,
      email: 'enqueue@example.com',
      passwordHash: await hashSecret('irrelevant-password-123'),
      emailVerifiedAt: new Date(),
    });
    const token = await signAccessToken(
      { sub: userId, sid: newId(), did: null, role: 'user', plan: null, ver: 0 },
      app.config.JWT_PRIVATE_KEY!,
    );
    const queue = new Queue(PAYMENTS_NOTIFY_JOB, { connection: app.redis });
    await queue.obliterate({ force: true });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payment-claims',
      headers: { authorization: `Bearer ${token}` },
      payload: { planCode: 'pro', paypalTransactionId: '7AB12345CD678901E' },
    });
    expect(res.statusCode).toBe(201);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.map((j) => j.data)).toEqual([{ claimId: res.json().id }]);
    expect(jobs[0]!.opts.attempts).toBe(5);
    await queue.obliterate({ force: true });
    await queue.close();
  });
});
