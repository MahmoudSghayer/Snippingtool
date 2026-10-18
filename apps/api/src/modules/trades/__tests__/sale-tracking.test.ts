// Following a bought card to its sale across browsers and devices
// (migration 0040, docs/06-extension.md "Trade lifecycle"):
//
// - the buy report carries EA's item id, stored on the trade;
// - `GET /extension/open-trades` hands a browser the caller's trades still
//   `bought`, so it can follow (and report the sale of) a card another
//   browser bought;
// - a sale the extension inferred (a listed card that left the trade pile
//   unseen) is stored as `inferred`, and one another browser saw replaces it;
// - `POST /trades/mark-sold` lets the trader record the rest from the
//   dashboard, at one price for several bought trades of one card, with
//   `GET /trades/sell-price` for its default.

import { auditLogs, profits, trades, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { OPEN_TRADES_MAX } from '@sl/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';
import { grantPlan } from '../../../test/plan-fixtures.js';

import type { FastifyInstance } from 'fastify';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function createUser(
  app: FastifyInstance,
  email: string,
  { plan = true }: { plan?: boolean } = {},
): Promise<{ userId: string; token: string }> {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    emailVerifiedAt: new Date(),
  });
  // A Monthly pass: these routes are plan-gated on `ledger.recorder`.
  if (plan) await grantPlan(app, userId);
  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'user', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

function tradePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    tradeId: 'trade-1',
    resourceId: 158023,
    assetId: 158023,
    rating: 91,
    buyPrice: 20000,
    sellPrice: null,
    eaTax: 0.05,
    netProfit: null,
    status: 'bought',
    boughtAt: new Date(Date.now() - 30 * MINUTE).toISOString(),
    soldAt: null,
    ...overrides,
  };
}

type TradeInsert = typeof trades.$inferInsert;

function row(userId: string, overrides: Partial<TradeInsert> = {}): TradeInsert & { id: string } {
  return {
    id: newId(),
    userId,
    tradeId: newId(),
    itemId: null,
    resourceId: '158023',
    rating: 91,
    buyPrice: 10_000,
    status: 'bought',
    boughtAt: new Date(Date.now() - DAY),
    ...overrides,
  };
}

describe('sale tracking (item ids, open trades, inferred and manual sales)', () => {
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

  const batch = (token: string, payload: Record<string, unknown>[]) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { trades: payload },
    });

  const findTrade = (userId: string, tradeId: string) =>
    app.db.query.trades.findFirst({
      where: and(eq(trades.userId, userId), eq(trades.tradeId, tradeId)),
    });

  describe('item id on the buy report', () => {
    it("stores the card's item id, and a sale report without one (or without the card fields) keeps them", async () => {
      const { userId, token } = await createUser(app, 'item-id@example.com');
      const bought = tradePayload({ tradeId: 'buy-1', itemId: '900001' });
      expect((await batch(token, [bought])).statusCode).toBe(200);
      expect(await findTrade(userId, 'buy-1')).toMatchObject({
        itemId: '900001',
        assetId: '158023',
        rating: 91,
        status: 'bought',
        saleSource: null,
      });

      // What a browser that learned of the card from /extension/open-trades
      // sends, or an older extension: no item id, no asset id.
      const sale = {
        ...bought,
        id: newId(),
        itemId: undefined,
        assetId: null,
        rating: null,
        status: 'sold',
        sellPrice: 25000,
        soldAt: new Date(Date.now() - MINUTE).toISOString(),
      };
      expect((await batch(token, [sale])).statusCode).toBe(200);
      expect(await findTrade(userId, 'buy-1')).toMatchObject({
        itemId: '900001',
        assetId: '158023',
        rating: 91,
        status: 'sold',
        sellPrice: 25000,
        saleSource: 'observed',
      });
    });

    it('a buy re-sent with its item id (one reported before item ids) fills it in, and never undoes a sale', async () => {
      const { userId, token } = await createUser(app, 'item-id-backfill@example.com');
      const open = tradePayload({ tradeId: 'old-open' });
      const sold = tradePayload({
        tradeId: 'old-sold',
        status: 'sold',
        sellPrice: 25000,
        soldAt: new Date(Date.now() - MINUTE).toISOString(),
      });
      await batch(token, [open, sold]);
      expect((await findTrade(userId, 'old-open'))?.itemId).toBeNull();

      const resent = [
        { ...open, id: newId(), itemId: '900001', assetId: null },
        {
          ...sold,
          id: newId(),
          itemId: '900002',
          assetId: null,
          status: 'bought',
          sellPrice: null,
          soldAt: null,
        },
      ];
      expect((await batch(token, resent)).statusCode).toBe(200);
      expect(await findTrade(userId, 'old-open')).toMatchObject({
        itemId: '900001',
        status: 'bought',
        assetId: '158023',
      });
      expect(await findTrade(userId, 'old-sold')).toMatchObject({
        itemId: '900002',
        status: 'sold',
        sellPrice: 25000,
      });
    });

    it('rejects an item id out of bounds, and a report claiming a manual sale', async () => {
      const { token } = await createUser(app, 'item-id-bounds@example.com');
      expect((await batch(token, [tradePayload({ itemId: '' })])).statusCode).toBe(400);
      expect((await batch(token, [tradePayload({ itemId: 'x'.repeat(65) })])).statusCode).toBe(400);
      const manual = tradePayload({
        status: 'sold',
        sellPrice: 25000,
        soldAt: new Date().toISOString(),
        saleSource: 'manual',
      });
      expect((await batch(token, [manual])).statusCode).toBe(400);
    });
  });

  describe('inferred sales', () => {
    const sold = (bought: Record<string, unknown>, sellPrice: number, saleSource?: string) => ({
      ...bought,
      id: newId(),
      status: 'sold',
      sellPrice,
      soldAt: new Date(Date.now() - MINUTE).toISOString(),
      ...(saleSource ? { saleSource } : {}),
    });

    it('stores an inferred sale as such, with the profit the server computes', async () => {
      const { userId, token } = await createUser(app, 'inferred@example.com');
      const bought = tradePayload({ tradeId: 'inf-1', itemId: '1', buyPrice: 10000 });
      await batch(token, [bought]);
      expect((await batch(token, [sold(bought, 14000, 'inferred')])).statusCode).toBe(200);
      expect(await findTrade(userId, 'inf-1')).toMatchObject({
        status: 'sold',
        sellPrice: 14000,
        eaTax: 700,
        netProfit: 3300,
        saleSource: 'inferred',
      });
    });

    it('a sale another browser saw replaces an inferred one, never the other way round', async () => {
      const { userId, token } = await createUser(app, 'inferred-observed@example.com');
      const a = tradePayload({ tradeId: 'inf-a', itemId: 'a', buyPrice: 10000 });
      const b = tradePayload({ tradeId: 'inf-b', itemId: 'b', buyPrice: 10000 });
      await batch(token, [a, b]);

      await batch(token, [sold(a, 14000, 'inferred')]);
      await batch(token, [sold(a, 13500)]);
      expect(await findTrade(userId, 'inf-a')).toMatchObject({
        sellPrice: 13500,
        netProfit: 2825,
        saleSource: 'observed',
      });

      await batch(token, [sold(b, 13500)]);
      await batch(token, [sold(b, 14000, 'inferred')]);
      expect(await findTrade(userId, 'inf-b')).toMatchObject({
        sellPrice: 13500,
        saleSource: 'observed',
      });

      const [profitRow] = await app.db.query.profits.findMany({
        where: eq(profits.userId, userId),
      });
      expect(profitRow).toMatchObject({ netProfit: 2 * 2825, tradesClosed: 2 });
    });
  });

  describe('GET /api/v1/extension/open-trades', () => {
    const get = (token?: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/extension/open-trades',
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    it("returns only the caller's bought trades with an item id from the last 30 days, newest first", async () => {
      const { userId, token } = await createUser(app, 'open-trades@example.com');
      const other = await createUser(app, 'open-trades-other@example.com');
      const now = Date.now();
      await app.db.insert(trades).values([
        row(userId, {
          tradeId: 'newest',
          itemId: '1',
          buyPrice: 12_000,
          boughtAt: new Date(now - MINUTE),
        }),
        row(userId, {
          tradeId: 'older',
          itemId: '2',
          rating: null,
          resourceId: '50331700',
          boughtAt: new Date(now - 29 * DAY),
        }),
        // Left out: too old, sold, no item id, deleted, another user's.
        row(userId, { tradeId: 'too-old', itemId: '3', boughtAt: new Date(now - 31 * DAY) }),
        row(userId, {
          tradeId: 'sold',
          itemId: '4',
          status: 'sold',
          sellPrice: 14_000,
          soldAt: new Date(now - MINUTE),
        }),
        row(userId, { tradeId: 'no-item' }),
        row(userId, { tradeId: 'deleted', itemId: '5', deletedAt: new Date() }),
        row(other.userId, { tradeId: 'someone-else', itemId: '6' }),
      ]);

      const res = await get(token);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.truncated).toBe(false);
      expect(body.items).toEqual([
        {
          tradeId: 'newest',
          itemId: '1',
          resourceId: 158023,
          rating: 91,
          buyPrice: 12_000,
          boughtAt: new Date(now - MINUTE).toISOString(),
        },
        {
          tradeId: 'older',
          itemId: '2',
          resourceId: 50331700,
          rating: null,
          buyPrice: 10_000,
          boughtAt: new Date(now - 29 * DAY).toISOString(),
        },
      ]);

      // The other user sees only their own.
      const theirs = (await get(other.token)).json();
      expect(theirs.items.map((t: { tradeId: string }) => t.tradeId)).toEqual(['someone-else']);
    });

    it(`returns at most ${OPEN_TRADES_MAX}, the newest, and says it left some out`, async () => {
      const { userId, token } = await createUser(app, 'open-trades-many@example.com');
      const now = Date.now();
      await app.db.insert(trades).values(
        Array.from({ length: OPEN_TRADES_MAX + 1 }, (_, i) =>
          row(userId, {
            tradeId: `t-${i}`,
            itemId: String(i),
            boughtAt: new Date(now - (i + 1) * MINUTE),
          }),
        ),
      );
      const body = (await get(token)).json();
      expect(body.truncated).toBe(true);
      expect(body.items).toHaveLength(OPEN_TRADES_MAX);
      expect(body.items[0].tradeId).toBe('t-0');
      expect(body.items.at(-1).tradeId).toBe(`t-${OPEN_TRADES_MAX - 1}`);
    });

    it('needs a signed-in user with the ledger in their plan', async () => {
      expect((await get()).statusCode).toBe(401);
      const { token } = await createUser(app, 'open-trades-noplan@example.com', { plan: false });
      const res = await get(token);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN' });
    });
  });

  describe('POST /api/v1/trades/mark-sold', () => {
    const markSold = (token: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/trades/mark-sold',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

    it('records the sale of every bought trade at one price, with the profit per trade, as manual, audited', async () => {
      const { userId, token } = await createUser(app, 'mark-sold@example.com');
      const a = row(userId, { buyPrice: 10_000, itemId: '1' });
      const b = row(userId, { buyPrice: 12_000, itemId: '2' });
      await app.db.insert(trades).values([a, b]);

      const before = Date.now();
      const res = await markSold(token, { ids: [a.id, b.id, a.id], sellPrice: 15_000 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.skipped).toEqual([]);
      expect(body.updated).toHaveLength(2);

      // 5% of 15,000 = 750: 15,000 - 750 - 10,000 and - 12,000.
      const stored = await app.db.query.trades.findMany({ where: eq(trades.userId, userId) });
      const byId = new Map(stored.map((t) => [t.id, t]));
      expect(byId.get(a.id)).toMatchObject({
        status: 'sold',
        sellPrice: 15_000,
        eaTax: 750,
        netProfit: 4_250,
        saleSource: 'manual',
      });
      expect(byId.get(b.id)).toMatchObject({ eaTax: 750, netProfit: 2_250, saleSource: 'manual' });
      // Sold now, by default.
      expect(byId.get(a.id)!.soldAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(body.updated[0]).toMatchObject({ status: 'sold', saleSource: 'manual' });

      const profitRows = await app.db.query.profits.findMany({
        where: eq(profits.userId, userId),
      });
      expect(profitRows.reduce((sum, r) => sum + r.netProfit, 0)).toBe(6_500);
      expect(profitRows.reduce((sum, r) => sum + r.tradesClosed, 0)).toBe(2);

      const audits = await app.db.query.auditLogs.findMany({
        where: eq(auditLogs.action, 'trade.marked_sold'),
      });
      expect(audits.map((r) => r.entityId).sort()).toEqual([a.id, b.id].sort());
      expect(audits[0]).toMatchObject({ actorType: 'user', actorId: userId, entityType: 'trade' });
      expect(audits[0]!.after).toMatchObject({ status: 'sold', saleSource: 'manual' });
    });

    it("never touches another user's trade, or one that is not bought any more", async () => {
      const { userId, token } = await createUser(app, 'mark-sold-own@example.com');
      const other = await createUser(app, 'mark-sold-victim@example.com');
      const mine = row(userId);
      const alreadySold = row(userId, {
        status: 'sold',
        sellPrice: 20_000,
        eaTax: 1_000,
        netProfit: 9_000,
        soldAt: new Date(Date.now() - MINUTE),
        saleSource: 'observed',
      });
      const listed = row(userId, { status: 'listed' });
      const theirs = row(other.userId);
      await app.db.insert(trades).values([mine, alreadySold, listed, theirs]);
      const missing = newId();

      const res = await markSold(token, {
        ids: [theirs.id, alreadySold.id, listed.id, missing, mine.id],
        sellPrice: 15_000,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().updated.map((t: { id: string }) => t.id)).toEqual([mine.id]);
      expect(res.json().skipped).toEqual([
        { id: theirs.id, reason: 'not_found' },
        { id: alreadySold.id, reason: 'not_bought' },
        { id: listed.id, reason: 'not_bought' },
        { id: missing, reason: 'not_found' },
      ]);

      expect(
        await app.db.query.trades.findFirst({ where: eq(trades.id, theirs.id) }),
      ).toMatchObject({ status: 'bought', sellPrice: null, saleSource: null });
      expect(
        await app.db.query.trades.findFirst({ where: eq(trades.id, alreadySold.id) }),
      ).toMatchObject({ sellPrice: 20_000, saleSource: 'observed' });
    });

    it('skips a trade bought after the given sale time, and refuses trades of different cards', async () => {
      const { userId, token } = await createUser(app, 'mark-sold-rules@example.com');
      const early = row(userId, { boughtAt: new Date(Date.now() - 2 * DAY) });
      const late = row(userId, { boughtAt: new Date(Date.now() - MINUTE) });
      const otherCard = row(userId, { resourceId: '50331700' });
      await app.db.insert(trades).values([early, late, otherCard]);

      const soldAt = new Date(Date.now() - DAY).toISOString();
      const res = await markSold(token, { ids: [early.id, late.id], sellPrice: 15_000, soldAt });
      expect(res.statusCode).toBe(200);
      expect(res.json().updated.map((t: { id: string }) => t.id)).toEqual([early.id]);
      expect(res.json().updated[0].soldAt).toBe(soldAt);
      expect(res.json().skipped).toEqual([{ id: late.id, reason: 'sold_before_bought' }]);

      const mixed = await markSold(token, { ids: [late.id, otherCard.id], sellPrice: 15_000 });
      expect(mixed.statusCode).toBe(400);
      expect(
        await app.db.query.trades.findFirst({ where: eq(trades.id, otherCard.id) }),
      ).toMatchObject({ status: 'bought' });
    });

    it("rejects a price under EA's 200-coin floor, an empty list and unknown fields", async () => {
      const { userId, token } = await createUser(app, 'mark-sold-validation@example.com');
      const one = row(userId);
      await app.db.insert(trades).values([one]);
      expect((await markSold(token, { ids: [one.id], sellPrice: 199 })).statusCode).toBe(400);
      expect((await markSold(token, { ids: [], sellPrice: 15_000 })).statusCode).toBe(400);
      expect(
        (await markSold(token, { ids: [one.id], sellPrice: 15_000, netProfit: 1 })).statusCode,
      ).toBe(400);
      expect(await app.db.query.trades.findFirst({ where: eq(trades.id, one.id) })).toMatchObject({
        status: 'bought',
      });
    });

    it('needs a signed-in user with the ledger in their plan', async () => {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/api/v1/trades/mark-sold',
        payload: { ids: [newId()], sellPrice: 15_000 },
      });
      expect(unauthenticated.statusCode).toBe(401);
      const { token } = await createUser(app, 'mark-sold-noplan@example.com', { plan: false });
      const res = await markSold(token, { ids: [newId()], sellPrice: 15_000 });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN' });
    });

    it('requires the CSRF token on a cookie session', async () => {
      const { userId, token } = await createUser(app, 'mark-sold-csrf@example.com');
      const one = row(userId);
      await app.db.insert(trades).values([one]);
      const csrf = app.signCookie('mark-sold-csrf-token');
      const cookie = `sl_at=${token}; sl_csrf=${encodeURIComponent(csrf)}`;
      const payload = { ids: [one.id], sellPrice: 15_000 };

      const missing = await app.inject({
        method: 'POST',
        url: '/api/v1/trades/mark-sold',
        headers: { cookie },
        payload,
      });
      expect(missing.statusCode).toBe(403);
      expect(await app.db.query.trades.findFirst({ where: eq(trades.id, one.id) })).toMatchObject({
        status: 'bought',
      });

      const withToken = await app.inject({
        method: 'POST',
        url: '/api/v1/trades/mark-sold',
        headers: { cookie, 'x-csrf-token': csrf },
        payload,
      });
      expect(withToken.statusCode).toBe(200);
      expect(withToken.json().updated).toHaveLength(1);
    });
  });

  describe('POST /api/v1/trades/:id/close', () => {
    it('records the sale as manual and audits it', async () => {
      const { userId, token } = await createUser(app, 'close-manual@example.com');
      const one = row(userId, { buyPrice: 10_000 });
      await app.db.insert(trades).values([one]);
      const soldAt = new Date(Date.now() - MINUTE).toISOString();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/trades/${one.id}/close`,
        headers: { authorization: `Bearer ${token}` },
        payload: { sellPrice: 14_000, soldAt },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'sold',
        sellPrice: 14_000,
        netProfit: 3_300,
        soldAt,
        saleSource: 'manual',
      });
      const audits = await app.db.query.auditLogs.findMany({
        where: eq(auditLogs.entityId, one.id),
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'trade.marked_sold', actorId: userId });
    });
  });

  describe('GET /api/v1/trades/sell-price', () => {
    const get = (token: string, resourceId: number | string) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/trades/sell-price?resourceId=${resourceId}`,
        headers: { authorization: `Bearer ${token}` },
      });

    it("averages the caller's latest sales of the card, leaving out quick sells, other cards and users", async () => {
      const { userId, token } = await createUser(app, 'sell-price@example.com');
      const other = await createUser(app, 'sell-price-other@example.com');
      const soldRow = (
        owner: string,
        sellPrice: number,
        minutesAgo: number,
        resourceId = '158023',
      ) =>
        row(owner, {
          resourceId,
          status: 'sold',
          sellPrice,
          soldAt: new Date(Date.now() - minutesAgo * MINUTE),
        });
      await app.db.insert(trades).values([
        soldRow(userId, 14_000, 1),
        soldRow(userId, 15_000, 2),
        soldRow(userId, 15_500, 3),
        soldRow(userId, 0, 4), // a quick sell
        soldRow(userId, 90_000, 5, '50331700'),
        soldRow(other.userId, 99_000, 1),
        row(userId), // still bought
      ]);

      const res = await get(token, 158023);
      expect(res.statusCode).toBe(200);
      // (14,000 + 15,000 + 15,500) / 3 = 14,833.3
      expect(res.json()).toEqual({ resourceId: 158023, averageSellPrice: 14_833, sales: 3 });

      expect((await get(token, 1)).json()).toEqual({
        resourceId: 1,
        averageSellPrice: null,
        sales: 0,
      });
      expect((await get(token, 'abc')).statusCode).toBe(400);
    });
  });
});
