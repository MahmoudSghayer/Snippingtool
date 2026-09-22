// QA coverage for the market module (apps/api/src/modules/market) —
// docs/14-ml-suggestions.md Phase B.
//
// Two things here are worth more than the aggregation arithmetic:
//
//   1. The pooled scope must never expose a slice traceable to fewer than
//      MIN_CONTRIBUTORS people (docs/14 §12). That is a privacy commitment,
//      and it fails silently if it regresses — a too-thin row simply appears
//      and nobody notices.
//   2. An empty result must say *why*. "No rows" is ambiguous between a
//      quiet market, no contributors, and a suppression, and the quiet-market
//      reading is exactly how a broken pipeline looks (docs/14 §14).

import { snipingActivity } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MIN_CONTRIBUTORS } from '../../../modules/market/index.js';
import { bearer, buildTestApp, createUserSession, type TestApp } from '../helpers.js';

const RESOURCE = '50535432';
const OTHER_RESOURCE = '90210111';

describe('market intelligence (Phase B)', () => {
  let app: TestApp;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
  });

  /** Writes observed-listing rows directly: `sniping_activity` is the
   * extension's ingest, and driving a whole bot run to produce three rows
   * would test BullMQ rather than the aggregation under test. */
  async function observe(
    userId: string,
    rows: Array<{
      resourceId: string;
      listedPrice: number | null;
      hoursAgo: number;
      success?: boolean;
    }>,
  ) {
    await app.db.insert(snipingActivity).values(
      rows.map((r) => ({
        userId,
        resourceId: r.resourceId,
        targetPrice: r.listedPrice ?? 1000,
        listedPrice: r.listedPrice,
        outcome: (r.success ? 'success' : 'attempted') as 'success' | 'attempted',
        occurredAt: new Date(Date.now() - r.hoursAgo * 3600_000),
      })),
    );
  }

  async function get(url: string, token: string) {
    const res = await app.inject({ method: 'GET', url, headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  describe('activity', () => {
    it('aggregates the caller’s own observations with a median, not a mean', async () => {
      const me = await createUserSession(app, 'market-a@test.dev', 'fp-market-a-000000000000');
      // 100 / 200 / 9000: the mean would be ~3100, which no listing resembled.
      await observe(me.userId, [
        { resourceId: RESOURCE, listedPrice: 100, hoursAgo: 1 },
        { resourceId: RESOURCE, listedPrice: 200, hoursAgo: 2, success: true },
        { resourceId: RESOURCE, listedPrice: 9000, hoursAgo: 3 },
      ]);

      const body = await get('/api/v1/market/activity?window=24h&scope=mine', me.accessToken);

      expect(body.rows).toHaveLength(1);
      const row = body.rows[0];
      expect(row.resourceId).toBe(RESOURCE);
      expect(row.attempts).toBe(3);
      expect(row.successes).toBe(1);
      expect(row.successRate).toBeCloseTo(1 / 3);
      expect(row.medianListedPrice).toBe(200);
      expect(row.minListedPrice).toBe(100);
      expect(row.maxListedPrice).toBe(9000);
      expect(body.meta.emptyReason).toBeNull();
    });

    it('excludes observations outside the window', async () => {
      const me = await createUserSession(app, 'market-b@test.dev', 'fp-market-b-000000000000');
      await observe(me.userId, [
        { resourceId: RESOURCE, listedPrice: 500, hoursAgo: 1 },
        { resourceId: RESOURCE, listedPrice: 500, hoursAgo: 100 }, // outside 24h
      ]);

      const body = await get('/api/v1/market/activity?window=24h&scope=mine', me.accessToken);
      expect(body.rows[0].attempts).toBe(1);
    });

    it('scope=mine never shows another user’s observations', async () => {
      const me = await createUserSession(app, 'market-c@test.dev', 'fp-market-c-000000000000');
      const them = await createUserSession(app, 'market-d@test.dev', 'fp-market-d-000000000000');

      await observe(them.userId, [{ resourceId: OTHER_RESOURCE, listedPrice: 700, hoursAgo: 1 }]);

      const body = await get('/api/v1/market/activity?window=24h&scope=mine', me.accessToken);
      expect(body.rows).toHaveLength(0);
      expect(body.meta.emptyReason).toMatch(/your own/i);
    });

    it('explains an empty result rather than looking like a quiet market', async () => {
      const me = await createUserSession(app, 'market-e@test.dev', 'fp-market-e-000000000000');
      const body = await get('/api/v1/market/activity?window=24h&scope=market', me.accessToken);

      expect(body.rows).toHaveLength(0);
      expect(body.meta.emptyReason).toBeTruthy();
      expect(body.meta.suppressedForPrivacy).toBe(false);
    });
  });

  describe('pooled scope privacy threshold', () => {
    it(`withholds a card observed by fewer than ${MIN_CONTRIBUTORS} people`, async () => {
      const me = await createUserSession(app, 'market-f@test.dev', 'fp-market-f-000000000000');
      const second = await createUserSession(app, 'market-g@test.dev', 'fp-market-g-000000000000');

      // Two contributors — one short of the threshold.
      await observe(me.userId, [{ resourceId: RESOURCE, listedPrice: 1000, hoursAgo: 1 }]);
      await observe(second.userId, [{ resourceId: RESOURCE, listedPrice: 1100, hoursAgo: 1 }]);

      const body = await get('/api/v1/market/activity?window=24h&scope=market', me.accessToken);

      expect(body.rows).toHaveLength(0);
      expect(body.meta.suppressedForPrivacy).toBe(true);
      expect(body.meta.emptyReason).toMatch(new RegExp(String(MIN_CONTRIBUTORS)));
    });

    it('shows the card once enough distinct people have observed it', async () => {
      const sessions = [];
      for (let i = 0; i < MIN_CONTRIBUTORS; i += 1) {
        sessions.push(
          await createUserSession(app, `market-h${i}@test.dev`, `fp-market-h${i}-000000000000`),
        );
      }
      for (const s of sessions) {
        await observe(s.userId, [{ resourceId: RESOURCE, listedPrice: 1000, hoursAgo: 1 }]);
      }

      const body = await get(
        '/api/v1/market/activity?window=24h&scope=market',
        sessions[0]!.accessToken,
      );

      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].resourceId).toBe(RESOURCE);
      expect(body.meta.contributors).toBeGreaterThanOrEqual(MIN_CONTRIBUTORS);
      expect(body.meta.suppressedForPrivacy).toBe(false);
    });

    it('suppresses per row, so a thin card does not hide a well-observed one', async () => {
      const sessions = [];
      for (let i = 0; i < MIN_CONTRIBUTORS; i += 1) {
        sessions.push(
          await createUserSession(app, `market-i${i}@test.dev`, `fp-market-i${i}-000000000000`),
        );
      }
      // RESOURCE is well observed; OTHER_RESOURCE is seen by one person only.
      for (const s of sessions) {
        await observe(s.userId, [{ resourceId: RESOURCE, listedPrice: 1000, hoursAgo: 1 }]);
      }
      await observe(sessions[0]!.userId, [
        { resourceId: OTHER_RESOURCE, listedPrice: 5000, hoursAgo: 1 },
      ]);

      const body = await get(
        '/api/v1/market/activity?window=24h&scope=market',
        sessions[0]!.accessToken,
      );

      const ids = body.rows.map((r: { resourceId: string }) => r.resourceId);
      expect(ids).toContain(RESOURCE);
      expect(ids).not.toContain(OTHER_RESOURCE);
      expect(body.meta.suppressedForPrivacy).toBe(true);
    });
  });

  describe('movers', () => {
    it('reports a percentage change between a window and the one before it', async () => {
      const me = await createUserSession(app, 'market-j@test.dev', 'fp-market-j-000000000000');
      // Previous 24h (24–48h ago): median 1000. Current 24h: median 1500.
      await observe(me.userId, [
        { resourceId: RESOURCE, listedPrice: 1000, hoursAgo: 30 },
        { resourceId: RESOURCE, listedPrice: 1000, hoursAgo: 36 },
        { resourceId: RESOURCE, listedPrice: 1500, hoursAgo: 2 },
        { resourceId: RESOURCE, listedPrice: 1500, hoursAgo: 4 },
      ]);

      const body = await get('/api/v1/market/movers?window=24h&scope=mine', me.accessToken);

      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].previousMedian).toBe(1000);
      expect(body.rows[0].currentMedian).toBe(1500);
      expect(body.rows[0].changePct).toBeCloseTo(50);
    });

    it('ignores a card with too few priced samples to call a move', async () => {
      const me = await createUserSession(app, 'market-k@test.dev', 'fp-market-k-000000000000');
      // One observation either side: a 50% "move" computed from noise.
      await observe(me.userId, [
        { resourceId: RESOURCE, listedPrice: 1000, hoursAgo: 30 },
        { resourceId: RESOURCE, listedPrice: 1500, hoursAgo: 2 },
      ]);

      const body = await get('/api/v1/market/movers?window=24h&scope=mine', me.accessToken);

      expect(body.rows).toHaveLength(0);
      expect(body.meta.emptyReason).toMatch(/not enough observed prices/i);
    });

    it('ignores a card with no observations in the previous window', async () => {
      const me = await createUserSession(app, 'market-l@test.dev', 'fp-market-l-000000000000');
      await observe(me.userId, [
        { resourceId: RESOURCE, listedPrice: 1500, hoursAgo: 2 },
        { resourceId: RESOURCE, listedPrice: 1500, hoursAgo: 3 },
      ]);

      const body = await get('/api/v1/market/movers?window=24h&scope=mine', me.accessToken);
      expect(body.rows).toHaveLength(0);
    });
  });

  describe('card history', () => {
    it('returns a bucketed median series for one card', async () => {
      const me = await createUserSession(app, 'market-m@test.dev', 'fp-market-m-000000000000');
      await observe(me.userId, [
        { resourceId: RESOURCE, listedPrice: 1000, hoursAgo: 5 },
        { resourceId: RESOURCE, listedPrice: 1200, hoursAgo: 5 },
        { resourceId: RESOURCE, listedPrice: 2000, hoursAgo: 1 },
      ]);

      const body = await get(
        `/api/v1/market/cards/${RESOURCE}?window=24h&scope=mine`,
        me.accessToken,
      );

      expect(body.resourceId).toBe(RESOURCE);
      expect(body.points.length).toBeGreaterThanOrEqual(2);
      expect(body.points.at(-1).medianListedPrice).toBe(2000);
      // Unknown to `cards` — first-party observations arrive for cards no
      // collector has described, and that must not drop the series.
      expect(body.name).toBeNull();
    });

    it('omits observations with no listed price from the series', async () => {
      const me = await createUserSession(app, 'market-n@test.dev', 'fp-market-n-000000000000');
      await observe(me.userId, [{ resourceId: RESOURCE, listedPrice: null, hoursAgo: 1 }]);

      const body = await get(
        `/api/v1/market/cards/${RESOURCE}?window=24h&scope=mine`,
        me.accessToken,
      );

      expect(body.points).toHaveLength(0);
      expect(body.meta.emptyReason).toBeTruthy();
    });
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/market/activity' });
    expect(res.statusCode).toBe(401);
  });
});
