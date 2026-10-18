// GET /api/v1/admin/bot-performance — the Nova AI bot's race results,
// timings, search pace and where its time went, from seeded
// `sniping_activity` rows and bot-pace heartbeats; the user filter; the
// range defaults and bounds; and who may call it.

import { adminUsers, snipingActivity, userActivity, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { AdminBotPerformanceResponse, BotPace } from '@sl/shared';
import type { FastifyInstance } from 'fastify';

type Outcome = 'attempted' | 'success' | 'failed' | 'too_slow' | 'blocked' | 'error';

const ROUTE = '/api/v1/admin/bot-performance';
const FROM = '2026-10-01T10:00:00.000Z';
const TO = '2026-10-01T11:59:59.999Z';

async function createUser(app: FastifyInstance, email: string, role: 'user' | 'admin' = 'user') {
  const id = newId();
  await app.db.insert(users).values({
    id,
    email,
    passwordHash: 'x',
    role,
    emailVerifiedAt: new Date(),
    totpEnabledAt: role === 'admin' ? new Date() : null,
  });
  const token = await signAccessToken(
    { sub: id, sid: newId(), did: null, role, plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { id, token };
}

async function createAdmin(
  app: FastifyInstance,
  adminRole: 'super_admin' | 'support' | 'analyst',
  email: string,
) {
  const admin = await createUser(app, email, 'admin');
  await app.db
    .insert(adminUsers)
    .values({ id: newId(), userId: admin.id, adminRole, permissions: {} });
  return admin;
}

function attempt(
  userId: string,
  at: string,
  outcome: Outcome,
  timings: { search?: number; reaction?: number; buy?: number } = {},
) {
  return {
    id: newId(),
    userId,
    resourceId: '50331648',
    targetPrice: 10_000,
    listedPrice: 9_500,
    outcome,
    latencyMs: timings.buy ?? null,
    searchMs: timings.search ?? null,
    reactionMs: timings.reaction ?? null,
    occurredAt: new Date(at),
  };
}

const IDLE_PACE: BotPace = {
  windowMs: 120_000,
  searches: 0,
  withResults: 0,
  failed: 0,
  searchMsP50: null,
  searchMsP90: null,
  waitingMs: 0,
  backoffMs: 0,
  blockedMs: 0,
  breakMs: 0,
  cooldownMs: 0,
};

function heartbeat(userId: string, at: string, bot?: Partial<BotPace>) {
  return {
    id: newId(),
    userId,
    type: 'heartbeat' as const,
    metadata: {
      extensionVersion: '1.4.0',
      engineState: 'running',
      ...(bot ? { bot: { ...IDLE_PACE, ...bot } } : {}),
    },
    occurredAt: new Date(at),
  };
}

/** User A: two hours of bot activity inside [FROM, TO], plus rows just
 * outside the range that must not count. */
async function seedUserA(app: FastifyInstance, userId: string) {
  await app.db.insert(snipingActivity).values([
    attempt(userId, '2026-10-01T10:05:00.000Z', 'success', {
      search: 100,
      reaction: 20,
      buy: 200,
    }),
    attempt(userId, '2026-10-01T10:10:00.000Z', 'success', {
      search: 300,
      reaction: 40,
      buy: 400,
    }),
    attempt(userId, '2026-10-01T10:20:00.000Z', 'too_slow', {
      search: 500,
      reaction: 60,
      buy: 600,
    }),
    // Held back by the bot's own limits: counted, never timed.
    attempt(userId, '2026-10-01T10:30:00.000Z', 'blocked', {
      search: 9_999,
      reaction: 9_999,
      buy: 9_999,
    }),
    attempt(userId, '2026-10-01T11:05:00.000Z', 'failed', {
      search: 700,
      reaction: 80,
      buy: 800,
    }),
    attempt(userId, '2026-10-01T11:10:00.000Z', 'error', { search: 200, reaction: 30, buy: 900 }),
    attempt(userId, '2026-10-01T11:20:00.000Z', 'attempted'),
    // Outside the range.
    attempt(userId, '2026-10-01T09:59:59.999Z', 'success', { search: 1, reaction: 1, buy: 1 }),
    attempt(userId, '2026-10-01T12:00:00.000Z', 'success', { search: 1, reaction: 1, buy: 1 }),
  ]);
  await app.db.insert(userActivity).values([
    heartbeat(userId, '2026-10-01T10:02:00.000Z', {
      searches: 10,
      withResults: 2,
      failed: 1,
      searchMsP50: 150,
      searchMsP90: 300,
      waitingMs: 60_000,
      backoffMs: 6_000,
      breakMs: 12_000,
      cooldownMs: 6_000,
    }),
    heartbeat(userId, '2026-10-01T10:04:00.000Z', {
      searches: 14,
      withResults: 3,
      waitingMs: 72_000,
      blockedMs: 12_000,
      cooldownMs: 12_000,
    }),
    heartbeat(userId, '2026-10-01T11:02:00.000Z', {
      windowMs: 60_000,
      searches: 3,
      withResults: 1,
      waitingMs: 30_000,
      breakMs: 6_000,
    }),
    // A heartbeat without the bot pace (bot not running) and one outside
    // the range: neither counts.
    heartbeat(userId, '2026-10-01T10:06:00.000Z'),
    heartbeat(userId, '2026-10-01T12:00:00.001Z', { searches: 99 }),
  ]);
}

describe('GET /api/v1/admin/bot-performance', () => {
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
  });

  async function get(token: string, query: Record<string, string>) {
    const res = await app.inject({
      method: 'GET',
      url: `${ROUTE}?${new URLSearchParams(query).toString()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return res;
  }

  it("reports one user's race results, timings, pace, time split and hours", async () => {
    const { token } = await createAdmin(app, 'super_admin', 'perf-admin@example.com');
    const a = await createUser(app, 'perf-a@example.com');
    await seedUserA(app, a.id);

    const res = await get(token, { from: FROM, to: TO, userId: a.id });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminBotPerformanceResponse>();

    expect(body.from).toBe(FROM);
    expect(body.to).toBe(TO);
    expect(body.userId).toBe(a.id);
    expect(body.summary).toEqual({
      attempts: 7,
      won: 2,
      lost: 2,
      blocked: 1,
      errors: 1,
      unknown: 1,
      winRate: 0.5,
      searches: 27,
      searchesWithResults: 6,
      failedSearches: 1,
      searchesPerMinute: 5.4, // 27 searches over 300 s of reported running time
      runningMs: 300_000,
    });

    // percentile_cont interpolates: over 100,200,300,500,700 the 90th
    // percentile is 500 + 0.6 × 200 = 620. The blocked attempt's 9999s and
    // the out-of-range 1s never show up.
    expect(body.timings.overall).toEqual({
      attempts: 6,
      search: { p50: 300, p90: 620 },
      reaction: { p50: 40, p90: 72 },
      buy: { p50: 600, p90: 860 },
    });
    expect(body.timings.won).toEqual({
      attempts: 2,
      search: { p50: 200, p90: 280 },
      reaction: { p50: 30, p90: 38 },
      buy: { p50: 300, p90: 380 },
    });
    expect(body.timings.lost).toEqual({
      attempts: 2,
      search: { p50: 600, p90: 680 },
      reaction: { p50: 70, p90: 78 },
      buy: { p50: 700, p90: 780 },
    });

    // 300 s of running time: 162 s delay, 6 s backoff, 12 s limits, 18 s
    // breaks, 18 s cooldown, and the remaining 84 s searching and buying.
    const split = body.timeSplit!;
    expect(split.delay).toBeCloseTo(0.54);
    expect(split.backoff).toBeCloseTo(0.02);
    expect(split.limit).toBeCloseTo(0.04);
    expect(split.break).toBeCloseTo(0.06);
    expect(split.cooldown).toBeCloseTo(0.06);
    expect(split.other).toBeCloseTo(0.28);

    expect(body.hourly).toEqual([
      {
        hour: '2026-10-01T10:00:00.000Z',
        searches: 24,
        searchesPerMinute: 6,
        attempts: 4,
        won: 2,
        lost: 1,
        searchP50: 300,
        reactionP50: 40,
        buyP50: 400,
      },
      {
        hour: '2026-10-01T11:00:00.000Z',
        searches: 3,
        searchesPerMinute: 3,
        attempts: 3,
        won: 0,
        lost: 1,
        searchP50: 450,
        reactionP50: 55,
        buyP50: 850,
      },
    ]);
  });

  it('covers every user without userId, and only the one asked for with it', async () => {
    const { token } = await createAdmin(app, 'analyst', 'perf-analyst@example.com');
    const a = await createUser(app, 'perf-a2@example.com');
    const b = await createUser(app, 'perf-b2@example.com');
    await seedUserA(app, a.id);
    await app.db
      .insert(snipingActivity)
      .values([
        attempt(b.id, '2026-10-01T10:15:00.000Z', 'success', { search: 50, reaction: 5, buy: 50 }),
        attempt(b.id, '2026-10-01T10:16:00.000Z', 'success', { search: 50, reaction: 5, buy: 50 }),
      ]);
    await app.db
      .insert(userActivity)
      .values(heartbeat(b.id, '2026-10-01T10:30:00.000Z', { searches: 12 }));

    const all = (await get(token, { from: FROM, to: TO })).json<AdminBotPerformanceResponse>();
    expect(all.userId).toBeNull();
    expect(all.summary).toMatchObject({ attempts: 9, won: 4, lost: 2, searches: 39 });
    expect(all.summary.winRate).toBeCloseTo(4 / 6);

    const onlyB = (
      await get(token, { from: FROM, to: TO, userId: b.id })
    ).json<AdminBotPerformanceResponse>();
    expect(onlyB.userId).toBe(b.id);
    expect(onlyB.summary).toMatchObject({
      attempts: 2,
      won: 2,
      lost: 0,
      winRate: 1,
      searches: 12,
      searchesPerMinute: 6,
    });
    expect(onlyB.timings.overall.search).toEqual({ p50: 50, p90: 50 });
    expect(onlyB.timings.lost).toEqual({
      attempts: 0,
      search: { p50: null, p90: null },
      reaction: { p50: null, p90: null },
      buy: { p50: null, p90: null },
    });

    const onlyA = (
      await get(token, { from: FROM, to: TO, userId: a.id })
    ).json<AdminBotPerformanceResponse>();
    expect(onlyA.summary).toMatchObject({ attempts: 7, won: 2, searches: 27 });
  });

  it('returns zeros and nulls, with every hour still listed, for a range with no data', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'perf-empty@example.com');
    const a = await createUser(app, 'perf-a3@example.com');
    await seedUserA(app, a.id);

    const res = await get(token, {
      from: '2026-09-01T00:30:00.000Z',
      to: '2026-09-01T02:00:00.000Z',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminBotPerformanceResponse>();
    expect(body.summary).toEqual({
      attempts: 0,
      won: 0,
      lost: 0,
      blocked: 0,
      errors: 0,
      unknown: 0,
      winRate: null,
      searches: 0,
      searchesWithResults: 0,
      failedSearches: 0,
      searchesPerMinute: null,
      runningMs: 0,
    });
    const none = { p50: null, p90: null };
    expect(body.timings.overall).toEqual({
      attempts: 0,
      search: none,
      reaction: none,
      buy: none,
    });
    expect(body.timeSplit).toBeNull();
    expect(body.hourly.map((h) => h.hour)).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T01:00:00.000Z',
      '2026-09-01T02:00:00.000Z',
    ]);
    expect(body.hourly[0]).toEqual({
      hour: '2026-09-01T00:00:00.000Z',
      searches: 0,
      searchesPerMinute: null,
      attempts: 0,
      won: 0,
      lost: 0,
      searchP50: null,
      reactionP50: null,
      buyP50: null,
    });
  });

  it('defaults to the last 24 hours', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'perf-default@example.com');
    const a = await createUser(app, 'perf-a4@example.com');
    const now = Date.now();
    await app.db
      .insert(snipingActivity)
      .values([
        attempt(a.id, new Date(now - 3_600_000).toISOString(), 'success'),
        attempt(a.id, new Date(now - 25 * 3_600_000).toISOString(), 'success'),
      ]);

    const res = await get(token, {});
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminBotPerformanceResponse>();
    expect(Date.parse(body.to) - Date.parse(body.from)).toBe(24 * 3_600_000);
    expect(Math.abs(Date.parse(body.to) - now)).toBeLessThan(60_000);
    expect(body.summary.attempts).toBe(1);
    expect(body.hourly.length).toBe(25);
  });

  it('refuses a range past 31 days, from after to, a malformed user id or an unknown key', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'perf-bounds@example.com');
    const invalid: Record<string, string>[] = [
      { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.001Z' },
      { from: '2026-10-02T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      { userId: 'me' },
      { limit: '10' },
    ];
    for (const query of invalid) {
      const res = await get(token, query);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
    }
  });

  it('is for admins with analytics.read only', async () => {
    const support = await createAdmin(app, 'support', 'perf-support@example.com');
    expect((await get(support.token, {})).statusCode).toBe(403);

    const customer = await createUser(app, 'perf-customer@example.com');
    expect((await get(customer.token, { userId: customer.id })).statusCode).toBe(403);

    const analyst = await createAdmin(app, 'analyst', 'perf-analyst2@example.com');
    expect((await get(analyst.token, {})).statusCode).toBe(200);

    const anonymous = await app.inject({ method: 'GET', url: ROUTE });
    expect(anonymous.statusCode).toBe(401);
  });
});
