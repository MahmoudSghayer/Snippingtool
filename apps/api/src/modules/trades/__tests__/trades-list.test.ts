// GET /api/v1/trades, /trades/totals and /trades/export.csv — the
// dashboard's trades section: filters (status, purchase-day range in the
// trader's time zone), newest/oldest order, card names from `cards`, and
// totals over the whole filter rather than the page on screen.

import { cards, trades, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { CURRENT_FC_TITLE } from '../../../lib/collectors/resolver.js';
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
  // These routes are feature-gated on `ledger.recorder` (every plan
  // includes it — plugins/auth.ts `requireFeature`), so a bare user with no
  // subscription now gets a 403 rather than reaching the handler.
  await grantPlan(app, userId);
  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'user', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

type TradeInsert = typeof trades.$inferInsert;

function trade(userId: string, overrides: Partial<TradeInsert>): TradeInsert {
  return {
    id: newId(),
    userId,
    tradeId: newId(),
    resourceId: '158023',
    rating: 91,
    buyPrice: 10_000,
    status: 'bought',
    boughtAt: new Date('2026-09-10T12:00:00.000Z'),
    ...overrides,
  };
}

/** A sold trade with the API's own profit maths (5% tax). */
function sold(userId: string, buy: number, sell: number, overrides: Partial<TradeInsert> = {}) {
  const eaTax = Math.round(sell * 0.05);
  return trade(userId, {
    status: 'sold',
    buyPrice: buy,
    sellPrice: sell,
    eaTax,
    netProfit: sell - eaTax - buy,
    soldAt: new Date('2026-09-11T12:00:00.000Z'),
    ...overrides,
  });
}

describe('trades list, totals and export (/api/v1/trades*)', () => {
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

  async function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  it('names each trade from `cards` for the current FC title, falling back to null', async () => {
    const { userId, token } = await createUser(app, 'list-names@example.com');
    await app.db.insert(cards).values([
      {
        resourceId: '158023',
        fcTitle: CURRENT_FC_TITLE,
        name: 'Lionel Messi',
        commonName: 'Messi',
        rating: 88,
      },
      // Same resource id in an older title: must not be picked.
      { resourceId: '158023', fcTitle: 'fc-old', name: 'Old Card', rating: 94 },
      { resourceId: '20801', fcTitle: CURRENT_FC_TITLE, name: 'Cristiano Ronaldo', rating: 86 },
    ]);
    await app.db.insert(trades).values([
      trade(userId, { tradeId: 'messi', resourceId: '158023', rating: 91 }),
      // No rating reported: the card's rating fills in.
      trade(userId, { tradeId: 'ronaldo', resourceId: '20801', rating: null }),
      trade(userId, { tradeId: 'unknown', resourceId: '999999', rating: 75 }),
    ]);

    const res = await get('/api/v1/trades', token);
    expect(res.statusCode).toBe(200);
    const byTradeId = Object.fromEntries(
      (res.json().items as { tradeId: string }[]).map((t) => [t.tradeId, t]),
    );
    expect(byTradeId.messi).toMatchObject({ cardName: 'Messi', rating: 91 });
    expect(byTradeId.ronaldo).toMatchObject({ cardName: 'Cristiano Ronaldo', rating: 86 });
    expect(byTradeId.unknown).toMatchObject({ cardName: null, rating: 75, resourceId: 999999 });
  });

  it('filters by status', async () => {
    const { userId, token } = await createUser(app, 'list-status@example.com');
    await app.db
      .insert(trades)
      .values([
        trade(userId, { tradeId: 'b1' }),
        trade(userId, { tradeId: 'l1', status: 'listed' }),
        sold(userId, 10_000, 12_000, { tradeId: 's1' }),
        trade(userId, { tradeId: 'e1', status: 'expired' }),
      ]);

    const res = await get('/api/v1/trades?status=sold', token);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((t: { tradeId: string }) => t.tradeId)).toEqual(['s1']);

    const bad = await get('/api/v1/trades?status=stolen', token);
    expect(bad.statusCode).toBe(400);
  });

  it('filters by purchase day, inclusive, in the given time zone', async () => {
    const { userId, token } = await createUser(app, 'list-range@example.com');
    await app.db.insert(trades).values([
      // 23:30 UTC on the 9th is already the 10th in Tokyo (UTC+9).
      trade(userId, { tradeId: 'late-9th', boughtAt: new Date('2026-09-09T23:30:00.000Z') }),
      trade(userId, { tradeId: 'noon-10th', boughtAt: new Date('2026-09-10T12:00:00.000Z') }),
      // 16:00 UTC on the 10th is the 11th in Tokyo.
      trade(userId, { tradeId: 'eve-10th', boughtAt: new Date('2026-09-10T16:00:00.000Z') }),
      trade(userId, { tradeId: 'noon-12th', boughtAt: new Date('2026-09-12T12:00:00.000Z') }),
    ]);
    const ids = (body: { items: { tradeId: string }[] }) => body.items.map((t) => t.tradeId);

    const utc = await get('/api/v1/trades?from=2026-09-10&to=2026-09-10', token);
    expect(utc.statusCode).toBe(200);
    expect(ids(utc.json())).toEqual(['eve-10th', 'noon-10th']);

    const tokyo = await get('/api/v1/trades?from=2026-09-10&to=2026-09-10&tz=Asia/Tokyo', token);
    expect(tokyo.statusCode).toBe(200);
    expect(ids(tokyo.json())).toEqual(['noon-10th', 'late-9th']);

    const inverted = await get('/api/v1/trades?from=2026-09-12&to=2026-09-10', token);
    expect(inverted.statusCode).toBe(400);
    const badTz = await get('/api/v1/trades?tz=Mars/Olympus', token);
    expect(badTz.statusCode).toBe(400);
  });

  it('sorts oldest first on request, and pages through the filtered set either way', async () => {
    const { userId, token } = await createUser(app, 'list-order@example.com');
    await app.db.insert(trades).values(
      [1, 2, 3, 4, 5].map((d) =>
        trade(userId, {
          tradeId: `t${d}`,
          boughtAt: new Date(`2026-09-0${d}T12:00:00.000Z`),
          status: d % 2 === 0 ? 'listed' : 'bought',
        }),
      ),
    );

    const page1 = await get('/api/v1/trades?order=asc&limit=2&status=bought', token);
    expect(page1.statusCode).toBe(200);
    expect(page1.json().items.map((t: { tradeId: string }) => t.tradeId)).toEqual(['t1', 't3']);
    const cursor = page1.json().nextCursor as string;
    expect(cursor).toBeTruthy();

    const page2 = await get(
      `/api/v1/trades?order=asc&limit=2&status=bought&cursor=${encodeURIComponent(cursor)}`,
      token,
    );
    expect(page2.json().items.map((t: { tradeId: string }) => t.tradeId)).toEqual(['t5']);
    expect(page2.json().nextCursor).toBeNull();

    const desc = await get('/api/v1/trades?limit=2', token);
    expect(desc.json().items.map((t: { tradeId: string }) => t.tradeId)).toEqual(['t5', 't4']);
  });

  it('totals: spent, revenue and net over every trade the filter matches, not just one page', async () => {
    const { userId, token } = await createUser(app, 'list-totals@example.com');
    const { userId: other } = await createUser(app, 'list-totals-other@example.com');
    await app.db.insert(trades).values([
      sold(userId, 10_000, 14_000), // net 14,000 - 700 - 10,000 = 3,300
      sold(userId, 20_000, 16_000), // net 16,000 - 800 - 20,000 = -4,800
      trade(userId, { buyPrice: 5_000 }),
      trade(userId, { buyPrice: 7_000, deletedAt: new Date() }), // deleted: never counted
      sold(other, 1_000, 900_000), // another user's: never counted
    ]);

    const all = await get('/api/v1/trades/totals', token);
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({
      count: 3,
      sold: 2,
      spent: 35_000,
      revenue: 30_000,
      netProfit: 3_300 - 4_800,
    });

    const onlySold = await get('/api/v1/trades/totals?status=bought', token);
    expect(onlySold.json()).toEqual({ count: 1, sold: 0, spent: 5_000, revenue: 0, netProfit: 0 });
  });

  it('export.csv: every matching trade with its card name, and names cannot inject formulas', async () => {
    const { userId, token } = await createUser(app, 'list-csv@example.com');
    await app.db.insert(cards).values([
      { resourceId: '1', fcTitle: CURRENT_FC_TITLE, name: '=HYPERLINK("http://evil")' },
      { resourceId: '2', fcTitle: CURRENT_FC_TITLE, name: 'Pelé, the King' },
    ]);
    await app.db
      .insert(trades)
      .values([
        sold(userId, 10_000, 14_000, { tradeId: 'a', resourceId: '1' }),
        trade(userId, { tradeId: 'b', resourceId: '2', status: 'listed' }),
        trade(userId, { tradeId: 'c', resourceId: '3', status: 'expired' }),
      ]);

    const res = await get('/api/v1/trades/export.csv?status=sold', token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split(/\r\n/);
    expect(lines[0]).toBe(
      'tradeId,card,resourceId,rating,status,buyPrice,sellPrice,eaTax,netProfit,boughtAt,soldAt',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[1]).toContain(',14000,700,3300,');

    const everything = await get('/api/v1/trades/export.csv', token);
    expect(everything.body).toContain('"Pelé, the King"');
    expect(everything.body.trim().split(/\r\n/)).toHaveLength(4);
  });
});
