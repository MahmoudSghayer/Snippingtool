// Ingest correctness (P0 task 11): the extension retries, runs its trade and
// sniping flushes concurrently, and its clock and prices are client input.
// None of that may duplicate stats, 500 a batch, or put a row somewhere
// `partitions.maintain` cannot cope with.

import { profits, snipingActivity, trades, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';
import { grantPlan } from '../../../test/plan-fixtures.js';

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
  // A Monthly pass: these routes are plan-gated (requireFeature).
  await grantPlan(app, userId);
  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'user', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: newId(),
    resourceId: 1,
    targetPrice: 100,
    listedPrice: 100,
    outcome: 'success',
    latencyMs: 10,
    errorCode: null,
    occurredAt: new Date(Date.now() - MINUTE).toISOString(),
    deviceId: newId(),
    ...overrides,
  };
}

function trade(overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    tradeId: `t-${newId()}`,
    resourceId: 158023,
    assetId: null,
    rating: 91,
    buyPrice: 20000,
    sellPrice: null,
    eaTax: 0.05,
    netProfit: null,
    status: 'bought',
    boughtAt: new Date(Date.now() - MINUTE).toISOString(),
    soldAt: null,
    ...overrides,
  };
}

describe('ingest correctness', () => {
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

  function post(url: string, token: string, payload: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });
  }

  describe('sniping idempotency', () => {
    it('a retried attempt (same attemptId and occurredAt) is stored and counted once', async () => {
      const { userId, token } = await createUser(app, 'dup-attempt@example.com');
      const a = attempt();

      const first = await post('/api/v1/sniping/attempts', token, { attempts: [a] });
      expect(first.statusCode).toBe(200);
      const retry = await post('/api/v1/sniping/attempts', token, { attempts: [a] });
      expect(retry.statusCode).toBe(200);

      const rows = await app.db.query.snipingActivity.findMany({
        where: eq(snipingActivity.userId, userId),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.attemptId).toBe(a.attemptId);
      const [profitRow] = await app.db.query.profits.findMany({
        where: eq(profits.userId, userId),
      });
      expect(profitRow).toMatchObject({ snipes: 1, successes: 1 });
    });

    it('still accepts an old client that sends no attemptId', async () => {
      const { userId, token } = await createUser(app, 'old-client@example.com');
      const { attemptId: _omit, ...legacy } = attempt();
      const res = await post('/api/v1/sniping/attempts', token, { attempts: [legacy, legacy] });
      expect(res.statusCode).toBe(200);
      const rows = await app.db.query.snipingActivity.findMany({
        where: eq(snipingActivity.userId, userId),
      });
      // Without an id the server cannot tell a retry from a second attempt.
      expect(rows).toHaveLength(2);
    });
  });

  describe('rollup under concurrency', () => {
    it('concurrent trade and sniping ingests for a new day both succeed and both land in the rollup', async () => {
      // Several users, so the race has plenty of chances to hit.
      for (let i = 0; i < 8; i++) {
        const { userId, token } = await createUser(app, `race-${i}@example.com`);
        const [t, s] = await Promise.all([
          post('/api/v1/trades/batch', token, { trades: [trade({ buyPrice: 700 })] }),
          post('/api/v1/sniping/attempts', token, { attempts: [attempt()] }),
        ]);
        expect(t.statusCode, t.body).toBe(200);
        expect(s.statusCode, s.body).toBe(200);

        const rows = await app.db.query.profits.findMany({ where: eq(profits.userId, userId) });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ coinsSpent: 700, snipes: 1, successes: 1 });
      }
    });
  });

  describe('trade batch', () => {
    it('upserts every trade in one batch, including a repeated tradeId (last one wins)', async () => {
      const { userId, token } = await createUser(app, 'upsert@example.com');
      const res = await post('/api/v1/trades/batch', token, {
        trades: [
          trade({ tradeId: 'same', buyPrice: 100 }),
          trade({ tradeId: 'other', buyPrice: 300 }),
          trade({ tradeId: 'same', buyPrice: 200 }),
        ],
      });
      expect(res.statusCode, res.body).toBe(200);
      const rows = await app.db.query.trades.findMany({ where: eq(trades.userId, userId) });
      expect(rows.map((r) => [r.tradeId, r.buyPrice]).sort()).toEqual([
        ['other', 300],
        ['same', 200],
      ]);
      const [profitRow] = await app.db.query.profits.findMany({
        where: eq(profits.userId, userId),
      });
      expect(profitRow?.coinsSpent).toBe(500);
    });
  });

  describe('bounds', () => {
    it('rejects a sniping attempt dated more than 5 minutes in the future with a 400', async () => {
      const { token } = await createUser(app, 'future-snipe@example.com');
      const res = await post('/api/v1/sniping/attempts', token, {
        attempts: [attempt({ occurredAt: new Date(Date.now() + 10 * MINUTE).toISOString() })],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('TIMESTAMP_OUT_OF_WINDOW');
      expect(res.json().details.indices).toEqual([0]);
      expect(res.body).toContain('occurredAt');
    });

    it('names exactly the out-of-window items of a batch, so the client can drop only those', async () => {
      const { token } = await createUser(app, 'window-indices@example.com');
      const res = await post('/api/v1/sniping/attempts', token, {
        attempts: [
          attempt(),
          attempt({ occurredAt: new Date(Date.now() + 10 * MINUTE).toISOString() }),
          attempt(),
          attempt({ occurredAt: new Date(Date.now() - 8 * DAY).toISOString() }),
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'TIMESTAMP_OUT_OF_WINDOW',
        details: { indices: [1, 3] },
      });
    });

    it('a batch with any other validation error is still VALIDATION_FAILED', async () => {
      const { token } = await createUser(app, 'window-mixed@example.com');
      const res = await post('/api/v1/sniping/attempts', token, {
        attempts: [
          attempt({ occurredAt: new Date(Date.now() + 10 * MINUTE).toISOString() }),
          attempt({ targetPrice: -1 }),
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
    });

    it('rejects a sniping attempt dated more than 7 days in the past with a 400', async () => {
      const { token } = await createUser(app, 'past-snipe@example.com');
      const res = await post('/api/v1/sniping/attempts', token, {
        attempts: [attempt({ occurredAt: new Date(Date.now() - 8 * DAY).toISOString() })],
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts a few minutes of client clock skew', async () => {
      const { token } = await createUser(app, 'skew@example.com');
      const res = await post('/api/v1/sniping/attempts', token, {
        attempts: [attempt({ occurredAt: new Date(Date.now() + 2 * MINUTE).toISOString() })],
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects an activity event dated far in the future with a 400', async () => {
      const { token } = await createUser(app, 'future-activity@example.com');
      const res = await post('/api/v1/activity/batch', token, {
        events: [
          {
            type: 'login',
            occurredAt: new Date(Date.now() + 365 * DAY).toISOString(),
          },
        ],
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a trade bought in the future or more than 400 days ago with a 400', async () => {
      const { token } = await createUser(app, 'future-trade@example.com');
      const future = await post('/api/v1/trades/batch', token, {
        trades: [trade({ boughtAt: new Date(Date.now() + DAY).toISOString() })],
      });
      expect(future.statusCode).toBe(400);
      expect(future.json().code).toBe('TIMESTAMP_OUT_OF_WINDOW');
      expect(future.body).toContain('boughtAt');

      const ancient = await post('/api/v1/trades/batch', token, {
        trades: [trade({ boughtAt: new Date(Date.now() - 401 * DAY).toISOString() })],
      });
      expect(ancient.statusCode).toBe(400);
    });

    // trades is not partitioned; the 7-day bound is only for the
    // partitioned activity tables. A card held for weeks must still get its
    // status updates, and the dashboard must still record an old sale.
    it('accepts a trade bought and sold more than 7 days ago, and a close of an old sale', async () => {
      const { userId, token } = await createUser(app, 'old-trade@example.com');
      const old = await post('/api/v1/trades/batch', token, {
        trades: [
          trade({
            status: 'sold',
            sellPrice: 30000,
            boughtAt: new Date(Date.now() - 40 * DAY).toISOString(),
            soldAt: new Date(Date.now() - 20 * DAY).toISOString(),
          }),
          trade({ tradeId: 'held', boughtAt: new Date(Date.now() - 40 * DAY).toISOString() }),
        ],
      });
      expect(old.statusCode, old.body).toBe(200);

      const held = await app.db.query.trades.findFirst({ where: eq(trades.tradeId, 'held') });
      const close = await post(`/api/v1/trades/${held!.id}/close`, token, {
        sellPrice: 25000,
        soldAt: new Date(Date.now() - 30 * DAY).toISOString(),
      });
      expect(close.statusCode, close.body).toBe(200);
      const rows = await app.db.query.trades.findMany({ where: eq(trades.userId, userId) });
      expect(rows.every((r) => r.status === 'sold')).toBe(true);
    });

    // M1: the stale-report guard keeps a recorded sale, but used to take the
    // report's purchase time even when that is after the recorded sale, and
    // trades_sold_after_bought then 500'd the whole batch.
    it('a stale report whose purchase time is after the recorded sale keeps the stored purchase time', async () => {
      const { userId, token } = await createUser(app, 'stale-bought@example.com');
      const boughtAt = new Date(Date.now() - 3 * DAY).toISOString();
      await post('/api/v1/trades/batch', token, { trades: [trade({ tradeId: 'x', boughtAt })] });
      const row = await app.db.query.trades.findFirst({ where: eq(trades.userId, userId) });
      const soldAt = new Date(Date.now() - 2 * DAY).toISOString();
      const close = await post(`/api/v1/trades/${row!.id}/close`, token, {
        sellPrice: 30000,
        soldAt,
      });
      expect(close.statusCode, close.body).toBe(200);

      const stale = await post('/api/v1/trades/batch', token, {
        trades: [
          trade({
            tradeId: 'x',
            status: 'bought',
            boughtAt: new Date(Date.now() - MINUTE).toISOString(),
          }),
        ],
      });
      expect(stale.statusCode, stale.body).toBe(200);
      const after = await app.db.query.trades.findFirst({ where: eq(trades.userId, userId) });
      expect(after).toMatchObject({ status: 'sold', sellPrice: 30000 });
      expect(after!.boughtAt!.toISOString()).toBe(boughtAt);
      expect(after!.soldAt!.toISOString()).toBe(soldAt);
    });

    // A stored trade can have no purchase time (bought_at is nullable). The
    // guard's fallback must keep it null, which the CHECK accepts, not take
    // the report's purchase time after the recorded sale.
    it('a stale report for a sold trade with no stored purchase time keeps it null', async () => {
      const { userId, token } = await createUser(app, 'null-bought@example.com');
      const soldAt = new Date(Date.now() - 2 * DAY);
      await app.db.insert(trades).values({
        id: newId(),
        userId,
        tradeId: 'nb',
        resourceId: '1',
        buyPrice: 1000,
        sellPrice: 2000,
        eaTax: 100,
        netProfit: 900,
        status: 'sold',
        boughtAt: null,
        soldAt,
      });
      const res = await post('/api/v1/trades/batch', token, {
        trades: [
          trade({
            tradeId: 'nb',
            buyPrice: 1000,
            boughtAt: new Date(Date.now() - MINUTE).toISOString(),
          }),
        ],
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = await app.db.query.trades.findFirst({ where: eq(trades.userId, userId) });
      expect(row).toMatchObject({ status: 'sold', boughtAt: null });
      expect(row!.soldAt!.toISOString()).toBe(soldAt.toISOString());
    });

    it('rejects an oversized price with a 400 instead of a 500', async () => {
      const { token } = await createUser(app, 'big-price@example.com');
      for (const overrides of [
        { buyPrice: 3_000_000_000 }, // past int4: used to 500 the whole batch
        { buyPrice: 15_000_001 },
        { buyPrice: 0 },
        { status: 'sold', sellPrice: 15_000_001 },
      ]) {
        const res = await post('/api/v1/trades/batch', token, { trades: [trade(overrides)] });
        expect(res.statusCode, JSON.stringify(overrides)).toBe(400);
      }
      const snipe = await post('/api/v1/sniping/attempts', token, {
        attempts: [attempt({ targetPrice: 3_000_000_000 })],
      });
      expect(snipe.statusCode).toBe(400);

      const inverted = await post('/api/v1/trades/batch', token, {
        trades: [
          trade({
            status: 'sold',
            sellPrice: 1000,
            boughtAt: new Date(Date.now() - MINUTE).toISOString(),
            soldAt: new Date(Date.now() - 2 * MINUTE).toISOString(),
          }),
        ],
      });
      expect(inverted.statusCode).toBe(400);

      const ok = await post('/api/v1/trades/batch', token, {
        trades: [trade({ buyPrice: 15_000_000 })],
      });
      expect(ok.statusCode).toBe(200);
    });

    it('rejects a close with an oversized sell price or a future sale date', async () => {
      const { userId, token } = await createUser(app, 'close-bounds@example.com');
      await post('/api/v1/trades/batch', token, { trades: [trade({ tradeId: 'c' })] });
      const row = await app.db.query.trades.findFirst({ where: eq(trades.userId, userId) });
      const big = await post(`/api/v1/trades/${row!.id}/close`, token, {
        sellPrice: 15_000_001,
      });
      expect(big.statusCode).toBe(400);
      const future = await post(`/api/v1/trades/${row!.id}/close`, token, {
        sellPrice: 1000,
        soldAt: new Date(Date.now() + DAY).toISOString(),
      });
      expect(future.statusCode).toBe(400);
    });
  });

  describe('trade list cursor', () => {
    it('returns every row exactly once when many trades share one bought_at', async () => {
      const { userId, token } = await createUser(app, 'ties@example.com');
      const tiedAt = new Date(Date.now() - 10 * MINUTE);
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const id = newId();
        ids.push(id);
        await app.db.insert(trades).values({
          id,
          userId,
          tradeId: `tie-${i}`,
          resourceId: '1',
          buyPrice: 100,
          status: 'bought',
          boughtAt: tiedAt,
        });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/trades?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { items: { id: string }[]; nextCursor: string | null };
        seen.push(...body.items.map((t) => t.id));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(ids.length);
      expect(new Set(seen)).toEqual(new Set(ids));
    });

    it('a malformed cursor is a 400, not a 500', async () => {
      const { token } = await createUser(app, 'bad-cursor@example.com');
      const cursor = Buffer.from(JSON.stringify({ v: 'not-a-date', id: 'nope' })).toString(
        'base64url',
      );
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/trades?cursor=${cursor}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
