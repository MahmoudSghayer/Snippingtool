// `fastify.requireFeature(feature)` (plugins/auth.ts): the plan gate on the
// ledger, assist and dashboard routes. Every gated route × a user who lacks
// the feature (no subscription, the retired `basic` plan, an expired pass)
// must 403 FEATURE_NOT_IN_PLAN before the handler or body validation runs;
// a Monthly (`pro`) or trial user must get through. The gate caches a
// user's features in Redis for a minute, and every `subscription.changed`
// publish drops that cache so a purchase or suspension applies on the very
// next request.

import { users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { type FeatureKey, type PlanCode } from '@sl/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { hashSecret } from '../../lib/crypto.js';
import { entitlementCacheKey } from '../../lib/entitlements.js';
import { newId } from '../../lib/ids.js';
import { signAccessToken } from '../../lib/tokens.js';
import { activateManual, suspend } from '../../modules/subscriptions/service.js';
import { grantExpiredPlan, grantPlan } from '../../test/plan-fixtures.js';
import { reseedPlans } from '../../test/reseed-reference-data.js';

import type { FastifyInstance } from 'fastify';

const NIL_LIKE_UUID = '00000000-0000-0000-0000-000000000000';
const TODAY = new Date().toISOString().slice(0, 10);
const RANGE = `from=${TODAY}&to=${TODAY}`;

interface GatedRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  feature: FeatureKey;
}

// One entry per `fastify.requireFeature(...)` route, from:
//   grep -rn "requireFeature(" apps/api/src/modules
// The ruling (task 8): ledger.recorder = trade/sniping ingest and reads plus
// extension telemetry; assist.filter_rotation = /filters*; assist.risk_meter
// = /risk-events; dashboard.analytics = /analytics/me/* and /market/*.
const GATED_ROUTES: GatedRoute[] = [
  { method: 'POST', url: '/api/v1/trades/batch', feature: 'ledger.recorder' },
  { method: 'POST', url: `/api/v1/trades/${NIL_LIKE_UUID}/close`, feature: 'ledger.recorder' },
  { method: 'GET', url: '/api/v1/trades', feature: 'ledger.recorder' },
  { method: 'POST', url: '/api/v1/sniping/attempts', feature: 'ledger.recorder' },
  { method: 'GET', url: `/api/v1/profits?${RANGE}`, feature: 'ledger.recorder' },
  { method: 'POST', url: '/api/v1/extension/telemetry', feature: 'ledger.recorder' },
  { method: 'GET', url: '/api/v1/filters', feature: 'assist.filter_rotation' },
  { method: 'POST', url: '/api/v1/filters', feature: 'assist.filter_rotation' },
  { method: 'PATCH', url: `/api/v1/filters/${NIL_LIKE_UUID}`, feature: 'assist.filter_rotation' },
  { method: 'DELETE', url: `/api/v1/filters/${NIL_LIKE_UUID}`, feature: 'assist.filter_rotation' },
  { method: 'GET', url: '/api/v1/filters/stats', feature: 'assist.filter_rotation' },
  { method: 'POST', url: '/api/v1/filters/stats', feature: 'assist.filter_rotation' },
  { method: 'POST', url: '/api/v1/risk-events', feature: 'assist.risk_meter' },
  { method: 'GET', url: '/api/v1/risk-events', feature: 'assist.risk_meter' },
  { method: 'GET', url: '/api/v1/analytics/me/overview', feature: 'dashboard.analytics' },
  { method: 'GET', url: `/api/v1/analytics/me/profits?${RANGE}`, feature: 'dashboard.analytics' },
  { method: 'GET', url: `/api/v1/analytics/me/activity?${RANGE}`, feature: 'dashboard.analytics' },
  { method: 'GET', url: '/api/v1/market/activity', feature: 'dashboard.analytics' },
  { method: 'GET', url: '/api/v1/market/movers', feature: 'dashboard.analytics' },
  { method: 'GET', url: '/api/v1/market/cards/158023', feature: 'dashboard.analytics' },
  { method: 'GET', url: '/api/v1/market/events', feature: 'dashboard.analytics' },
];

type Holder = 'none' | 'basic' | 'expired-pro' | 'pro' | 'trial';

describe('requireFeature: plan-gated routes', () => {
  let app: FastifyInstance;
  const tokens = new Map<Holder, string>();

  async function createUser(email: string): Promise<{ userId: string; token: string }> {
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

  const call = (route: Pick<GatedRoute, 'method' | 'url'>, token: string) =>
    app.inject({
      method: route.method,
      url: route.url,
      headers: { authorization: `Bearer ${token}` },
      // Writes get an empty body: past the gate that is a 400 (validation
      // runs after onRequest), which is all the positive case needs.
      ...(route.method === 'GET' ? {} : { payload: {} }),
    });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    app = await buildApp({ logger: false });
    await app.ready();
    await resetDatabase(app.db);
    await reseedPlans(app.db);

    // The matrix below only reads, so one user per kind of holder is shared.
    const holders: Array<[Holder, (userId: string) => Promise<unknown>]> = [
      ['none', async () => undefined],
      ['basic', (id) => grantPlan(app, id, 'basic')],
      ['expired-pro', (id) => grantExpiredPlan(app, id, 'pro')],
      ['pro', (id) => grantPlan(app, id, 'pro')],
      ['trial', (id) => grantPlan(app, id, 'trial')],
    ];
    for (const [holder, grant] of holders) {
      const { userId, token } = await createUser(`gate-${holder}@example.com`);
      await grant(userId);
      tokens.set(holder, token);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const denied: Array<{ holder: Holder; lacks: (f: FeatureKey) => boolean }> = [
    { holder: 'none', lacks: () => true },
    { holder: 'expired-pro', lacks: () => true },
    // The retired plan only ever had the recorder and price model.
    { holder: 'basic', lacks: (f) => f !== 'ledger.recorder' },
  ];

  for (const route of GATED_ROUTES) {
    for (const { holder, lacks } of denied) {
      if (!lacks(route.feature)) continue;
      it(`403s ${holder} (lacks ${route.feature}) → ${route.method} ${route.url}`, async () => {
        const res = await call(route, tokens.get(holder)!);
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json()).toMatchObject({
          code: 'FEATURE_NOT_IN_PLAN',
          details: { feature: route.feature },
        });
      });
    }

    for (const holder of ['pro', 'trial'] as const) {
      const expected = route.method === 'GET' ? 200 : 400;
      it(`lets ${holder} through (${expected}) → ${route.method} ${route.url}`, async () => {
        const res = await call(route, tokens.get(holder)!);
        // Editing or deleting a filter that doesn't exist (an empty PATCH is
        // valid) is a 404 once past the gate.
        const ok = route.method === 'DELETE' || route.method === 'PATCH' ? [404] : [expected];
        expect(ok, `${res.statusCode}: ${res.body}`).toContain(res.statusCode);
      });
    }
  }

  it('lets basic record trades (every live plan has ledger.recorder)', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/trades' }, tokens.get('basic')!);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('still answers 401, not 403, without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/filters' });
    expect(res.statusCode).toBe(401);
  });

  it('leaves heartbeat-style and account routes ungated for a user with no plan', async () => {
    const token = tokens.get('none')!;
    for (const url of ['/api/v1/extension/version', '/api/v1/settings', '/api/v1/devices']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${url}: ${res.body}`).not.toBe(403);
    }
  });
});

describe('requireFeature: entitlement cache', () => {
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

  async function createUser(email: string): Promise<{ userId: string; token: string }> {
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

  const getFilters = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/filters',
      headers: { authorization: `Bearer ${token}` },
    });

  it('caches the features per user for about a minute', async () => {
    const { userId, token } = await createUser('cache-ttl@example.com');
    await grantPlan(app, userId, 'pro');

    expect((await getFilters(token)).statusCode).toBe(200);

    const key = entitlementCacheKey(userId);
    const ttl = await app.redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(JSON.parse((await app.redis.get(key))!)).toContain('assist.filter_rotation');
  });

  it('applies a purchase on the very next request (subscription.changed drops the cache)', async () => {
    const { userId, token } = await createUser('cache-buy@example.com');

    expect((await getFilters(token)).statusCode).toBe(403);
    await activateManual(app.db, app.redis, {
      userId,
      planCode: 'pro' satisfies PlanCode,
      periodDays: 30,
      grantedByAdminId: null,
    });
    expect((await getFilters(token)).statusCode).toBe(200);
  });

  it('applies a suspension on the very next request', async () => {
    const { userId, token } = await createUser('cache-suspend@example.com');
    const { subscriptionId } = await grantPlan(app, userId, 'pro');

    expect((await getFilters(token)).statusCode).toBe(200);
    await suspend(app.db, app.redis, subscriptionId);
    const res = await getFilters(token);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FEATURE_NOT_IN_PLAN');
  });
});
