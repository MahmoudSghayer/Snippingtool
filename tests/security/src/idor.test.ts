// IDOR (insecure direct object reference): user A must never be able to
// read or mutate user B's own-scoped resources by guessing/reusing B's
// resource id — devices, sessions, saved filters, and the trades list.
// Every route under test here already scopes its query by
// `eq(<table>.userId, request.authUser!.id)` in the real implementation
// (apps/api/src/modules/{devices,sessions,filters,trades}/index.ts) — these
// tests exercise that scoping through the real HTTP surface rather than
// reading the source, so a future regression (a missing `eq(..., userId)`
// clause) fails here instead of shipping.

import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bearer, buildTestApp, createUserSession, NIL_LIKE_UUID, type TestApp, type UserSession } from './helpers.js';

describe('IDOR: user A cannot read or mutate user B\'s own-scoped resources', () => {
  let app: TestApp;
  let userA: UserSession;
  let userB: UserSession;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    app.mailer.sentEmails.length = 0;
    userA = await createUserSession(app, 'idor-a@example.com', 'idor-fp-a-000000000000001');
    userB = await createUserSession(app, 'idor-b@example.com', 'idor-fp-b-000000000000002');
  });

  it('devices: B cannot rename or revoke A\'s device', async () => {
    const listA = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: bearer(userA.accessToken) });
    const [deviceA] = listA.json() as Array<{ id: string }>;
    expect(deviceA).toBeTruthy();

    const renameRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/devices/${deviceA!.id}`,
      headers: bearer(userB.accessToken),
      payload: { name: 'hijacked' },
    });
    expect(renameRes.statusCode).toBe(404);

    const revokeRes = await app.inject({ method: 'DELETE', url: `/api/v1/devices/${deviceA!.id}`, headers: bearer(userB.accessToken) });
    expect(revokeRes.statusCode).toBe(404);

    // A's device is untouched — still listed, still active.
    const listAAfter = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: bearer(userA.accessToken) });
    const stillThere = (listAAfter.json() as Array<{ id: string; status: string }>).find((d) => d.id === deviceA!.id);
    expect(stillThere?.status).toBe('active');
  });

  it('sessions: B cannot list A\'s sessions by id or revoke them', async () => {
    const listA = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: bearer(userA.accessToken) });
    const [sessionA] = listA.json() as Array<{ id: string }>;
    expect(sessionA).toBeTruthy();

    // B's own session list never contains A's session id.
    const listB = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: bearer(userB.accessToken) });
    const idsB = (listB.json() as Array<{ id: string }>).map((s) => s.id);
    expect(idsB).not.toContain(sessionA!.id);

    const revokeRes = await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${sessionA!.id}`, headers: bearer(userB.accessToken) });
    expect(revokeRes.statusCode).toBe(404);

    // A's session (and therefore A's access token) still works.
    const stillWorks = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: bearer(userA.accessToken) });
    expect(stillWorks.statusCode).toBe(200);
  });

  it('saved filters: B cannot read, rename, delete, or see A\'s filter in their own list', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/filters',
      headers: bearer(userA.accessToken),
      payload: { name: "A's secret filter", filter: { minRating: 83 }, isActive: true },
    });
    expect(createRes.statusCode).toBe(201);
    const filterA = createRes.json() as { id: string };

    const listB = await app.inject({ method: 'GET', url: '/api/v1/filters', headers: bearer(userB.accessToken) });
    const idsB = (listB.json() as Array<{ id: string }>).map((f) => f.id);
    expect(idsB).not.toContain(filterA.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/filters/${filterA.id}`,
      headers: bearer(userB.accessToken),
      payload: { name: 'hijacked' },
    });
    expect(patchRes.statusCode).toBe(404);

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/v1/filters/${filterA.id}`, headers: bearer(userB.accessToken) });
    expect(deleteRes.statusCode).toBe(404);

    // A's filter is untouched, still there with its original name.
    const listA = await app.inject({ method: 'GET', url: '/api/v1/filters', headers: bearer(userA.accessToken) });
    const stillThere = (listA.json() as Array<{ id: string; name: string }>).find((f) => f.id === filterA.id);
    expect(stillThere?.name).toBe("A's secret filter");
  });

  it('trades: B\'s trade list never includes A\'s trades, even after A reports several', async () => {
    const reportRes = await app.inject({
      method: 'POST',
      url: '/api/v1/trades/batch',
      headers: bearer(userA.accessToken),
      payload: {
        trades: [
          {
            tradeId: 'idor-trade-1',
            resourceId: 111,
            rating: 83,
            buyPrice: 1000,
            sellPrice: 1400,
            eaTax: 0.05,
            netProfit: 330,
            status: 'sold',
            boughtAt: new Date().toISOString(),
            soldAt: new Date().toISOString(),
          },
        ],
      },
    });
    expect(reportRes.statusCode).toBe(200);

    const listB = await app.inject({ method: 'GET', url: '/api/v1/trades', headers: bearer(userB.accessToken) });
    expect(listB.statusCode).toBe(200);
    const itemsB = (listB.json() as { items: Array<{ tradeId: string }> }).items;
    expect(itemsB.find((t) => t.tradeId === 'idor-trade-1')).toBeUndefined();

    const listA = await app.inject({ method: 'GET', url: '/api/v1/trades', headers: bearer(userA.accessToken) });
    const itemsA = (listA.json() as { items: Array<{ tradeId: string }> }).items;
    expect(itemsA.find((t) => t.tradeId === 'idor-trade-1')).toBeTruthy();
  });

  it('a non-existent id 404s the same way a real-but-foreign one does (no existence oracle)', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/devices/${NIL_LIKE_UUID}`, headers: bearer(userA.accessToken) });
    expect(res.statusCode).toBe(404);
  });
});
