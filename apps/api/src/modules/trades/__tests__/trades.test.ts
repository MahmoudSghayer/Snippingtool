// /api/v1/trades — the API owns the profit maths and rolls `profits` up on
// every write, so the dashboard's numbers are never a client's claim and
// never an hour stale.

import { profits, trades, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

async function createUser(
  app: FastifyInstance,
  email: string,
): Promise<{ userId: string; token: string }> {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    emailVerifiedAt: new Date(),
  });
  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'user', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

function utcNoon(daysAgo: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 12),
  );
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function tradePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    tradeId: 'trade-1',
    resourceId: 158023,
    assetId: null,
    rating: 91,
    buyPrice: 20000,
    sellPrice: null,
    eaTax: 0.05,
    netProfit: null,
    status: 'bought',
    boughtAt: utcNoon(0).toISOString(),
    soldAt: null,
    ...overrides,
  };
}

describe('trades module (/api/v1/trades)', () => {
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

  it('batch: recomputes tax and net profit from the prices, ignoring what the client claimed', async () => {
    const { userId, token } = await createUser(app, 'trades-claims@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        trades: [
          tradePayload({
            tradeId: 'sold-1',
            buyPrice: 20000,
            sellPrice: 30000,
            eaTax: 0, // client claims no tax…
            netProfit: 999999, // …and a wildly inflated profit
            status: 'sold',
            soldAt: utcNoon(0).toISOString(),
          }),
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ upserted: 1 });

    const row = await app.db.query.trades.findFirst({
      where: and(eq(trades.userId, userId), eq(trades.tradeId, 'sold-1')),
    });
    expect(row?.eaTax).toBe(1500); // 5% of 30,000
    expect(row?.netProfit).toBe(8500); // 30,000 - 1,500 - 20,000

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/trades',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const [dto] = list.json().items;
    expect(dto.netProfit).toBe(8500);
    expect(dto.eaTax).toBeCloseTo(0.05, 10);
  });

  it('batch: a trade still in flight has no tax or profit yet', async () => {
    const { userId, token } = await createUser(app, 'trades-inflight@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { trades: [tradePayload({ tradeId: 'open-1', netProfit: 5000 })] },
    });
    expect(res.statusCode).toBe(200);
    const row = await app.db.query.trades.findFirst({
      where: and(eq(trades.userId, userId), eq(trades.tradeId, 'open-1')),
    });
    expect(row?.status).toBe('bought');
    expect(row?.eaTax).toBeNull();
    expect(row?.netProfit).toBeNull();
  });

  it('batch: rolls profits up immediately, on the day each event happened — including past days', async () => {
    const { userId, token } = await createUser(app, 'trades-rollup@example.com');
    const yesterday = utcNoon(1);
    const today = utcNoon(0);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        trades: [
          // Bought yesterday, sold today: spend lands on yesterday, profit on today.
          tradePayload({
            tradeId: 'cross-day',
            buyPrice: 10000,
            sellPrice: 12000,
            status: 'sold',
            boughtAt: yesterday.toISOString(),
            soldAt: today.toISOString(),
          }),
          // Bought and sold yesterday: the hourly job would never have seen this.
          tradePayload({
            tradeId: 'yesterday',
            buyPrice: 5000,
            sellPrice: 4000,
            status: 'sold',
            boughtAt: yesterday.toISOString(),
            soldAt: yesterday.toISOString(),
          }),
          // Still open today.
          tradePayload({ tradeId: 'open', buyPrice: 700, boughtAt: today.toISOString() }),
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const rows = await app.db.query.profits.findMany({ where: eq(profits.userId, userId) });
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r]));

    expect(byDay[day(yesterday)]).toMatchObject({
      coinsSpent: 15000,
      coinsEarned: 4000,
      netProfit: 4000 - 200 - 5000,
      tradesClosed: 1,
    });
    expect(byDay[day(today)]).toMatchObject({
      coinsSpent: 700,
      coinsEarned: 12000,
      netProfit: 12000 - 600 - 10000,
      tradesClosed: 1,
    });

    // …and the dashboard's overview reads the same numbers on its next request.
    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/analytics/me/overview',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().lifetimeNetProfit).toBe(1400 - 1200);
  });

  it('batch: re-reporting a trade re-rolls the day it moved away from', async () => {
    const { userId, token } = await createUser(app, 'trades-move@example.com');
    const yesterday = utcNoon(1);
    const today = utcNoon(0);

    const first = tradePayload({
      tradeId: 'moved',
      buyPrice: 1000,
      sellPrice: 2000,
      status: 'sold',
      boughtAt: yesterday.toISOString(),
      soldAt: yesterday.toISOString(),
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { trades: [first] },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { trades: [{ ...first, soldAt: today.toISOString() }] },
    });

    const rows = await app.db.query.profits.findMany({ where: eq(profits.userId, userId) });
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r]));
    expect(byDay[day(yesterday)]).toMatchObject({ coinsEarned: 0, netProfit: 0, tradesClosed: 0 });
    expect(byDay[day(today)]).toMatchObject({ coinsEarned: 2000, netProfit: 900, tradesClosed: 1 });
  });

  it('close: records the sale, computes the profit and rolls the day up', async () => {
    const { userId, token } = await createUser(app, 'trades-close@example.com');
    const bought = await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        trades: [
          tradePayload({
            tradeId: 'to-close',
            buyPrice: 20000,
            boughtAt: new Date(Date.now() - 60_000).toISOString(),
          }),
        ],
      },
    });
    expect(bought.statusCode).toBe(200);
    const row = await app.db.query.trades.findFirst({
      where: and(eq(trades.userId, userId), eq(trades.tradeId, 'to-close')),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/trades/${row!.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { sellPrice: 30000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: row!.id,
      status: 'sold',
      sellPrice: 30000,
      netProfit: 8500,
    });
    expect(res.json().soldAt).not.toBeNull();

    const [profitRow] = await app.db.query.profits.findMany({
      where: eq(profits.userId, userId),
    });
    expect(profitRow).toMatchObject({
      coinsSpent: 20000,
      coinsEarned: 30000,
      netProfit: 8500,
      tradesClosed: 1,
    });

    // Closing twice is a conflict, not a double-count.
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/trades/${row!.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { sellPrice: 31000 },
    });
    expect(again.statusCode).toBe(409);
  });

  it('batch: a stale `bought` report never erases a sale recorded with close', async () => {
    const { userId, token } = await createUser(app, 'trades-stale@example.com');
    const report = tradePayload({
      tradeId: 'stale',
      buyPrice: 20000,
      boughtAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { trades: [report] },
    });
    const row = await app.db.query.trades.findFirst({
      where: and(eq(trades.userId, userId), eq(trades.tradeId, 'stale')),
    });
    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/trades/${row!.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { sellPrice: 30000 },
    });
    expect(closed.statusCode).toBe(200);

    // The extension still believes the card is `bought` and re-reports it.
    const resync = await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { trades: [report, report] },
    });
    expect(resync.statusCode).toBe(200);
    expect(resync.json()).toEqual({ upserted: 1 });

    const after = await app.db.query.trades.findFirst({ where: eq(trades.id, row!.id) });
    expect(after).toMatchObject({ status: 'sold', sellPrice: 30000, netProfit: 8500 });
    const [profitRow] = await app.db.query.profits.findMany({
      where: eq(profits.userId, userId),
    });
    expect(profitRow).toMatchObject({ netProfit: 8500, tradesClosed: 1 });
  });

  it('close: rejects a sale dated before the purchase', async () => {
    const { userId, token } = await createUser(app, 'trades-close-early@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { trades: [tradePayload({ tradeId: 'early', boughtAt: utcNoon(0).toISOString() })] },
    });
    const row = await app.db.query.trades.findFirst({
      where: and(eq(trades.userId, userId), eq(trades.tradeId, 'early')),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/trades/${row!.id}/close`,
      headers: { authorization: `Bearer ${token}` },
      payload: { sellPrice: 1, soldAt: utcNoon(3).toISOString() },
    });
    expect(res.statusCode).toBe(400);
  });

  it("close: another user's trade is a 404, never closed", async () => {
    const { userId: owner, token: ownerToken } = await createUser(app, 'trades-owner@example.com');
    const { token: intruder } = await createUser(app, 'trades-intruder@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { trades: [tradePayload({ tradeId: 'mine' })] },
    });
    const row = await app.db.query.trades.findFirst({
      where: and(eq(trades.userId, owner), eq(trades.tradeId, 'mine')),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/trades/${row!.id}/close`,
      headers: { authorization: `Bearer ${intruder}` },
      payload: { sellPrice: 1 },
    });
    expect(res.statusCode).toBe(404);
    const after = await app.db.query.trades.findFirst({ where: eq(trades.id, row!.id) });
    expect(after?.status).toBe('bought');
  });

  it('sniping attempts roll snipe counts up immediately too', async () => {
    const { userId, token } = await createUser(app, 'trades-snipes@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sniping/attempts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        attempts: [
          {
            resourceId: 1,
            targetPrice: 100,
            listedPrice: 100,
            outcome: 'success',
            latencyMs: 10,
            errorCode: null,
            occurredAt: utcNoon(0).toISOString(),
            deviceId: newId(),
          },
          {
            resourceId: 1,
            targetPrice: 100,
            listedPrice: 100,
            outcome: 'too_slow',
            latencyMs: 10,
            errorCode: null,
            occurredAt: utcNoon(0).toISOString(),
            deviceId: newId(),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const [profitRow] = await app.db.query.profits.findMany({
      where: eq(profits.userId, userId),
    });
    expect(profitRow).toMatchObject({ snipes: 2, successes: 1 });
  });
});
