// /api/v1/admin/analytics/gallery — per-user Gallery usage (Sets completed,
// Gallery Tokens, coins spent, cards collected, first/last timestamps) merged
// across the three Gallery tables, the per-user completed-Set log, and
// permission/auth gating.

import { adminUsers, userGallery, userGalleryCompletions, userGalleryOwned, users } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { hashSecret } from '../../../lib/crypto.js';
import { newId } from '../../../lib/ids.js';
import { signAccessToken } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

async function createAdmin(
  app: FastifyInstance,
  adminRole: 'super_admin' | 'support' | 'analyst',
  email: string,
) {
  const userId = newId();
  await app.db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashSecret('irrelevant-password-123'),
    role: 'admin',
    emailVerifiedAt: new Date(),
    totpEnabledAt: new Date(),
  });
  await app.db.insert(adminUsers).values({ id: newId(), userId, adminRole, permissions: {} });
  const token = await signAccessToken(
    { sub: userId, sid: newId(), did: null, role: 'admin', plan: null, ver: 0 },
    app.config.JWT_PRIVATE_KEY!,
  );
  return { userId, token };
}

async function createUser(app: FastifyInstance, email: string): Promise<string> {
  const id = newId();
  await app.db.insert(users).values({ id, email, passwordHash: 'x', emailVerifiedAt: new Date() });
  return id;
}

const GALLERY_URL = '/api/v1/admin/analytics/gallery';

describe('admin-analytics gallery', () => {
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

  /** userA: 2 standing completions + 1 undone, 3 clubbed cards, a saved list
   * with spent/budget. userB: 1 completion (grade/tokens partly unknown), 1
   * card, no saved list. userC: a clubbed card but no completion. */
  async function seed() {
    const userA = await createUser(app, 'gallery-a@example.com');
    const userB = await createUser(app, 'gallery-b@example.com');
    const userC = await createUser(app, 'gallery-c@example.com');

    await app.db.insert(userGalleryCompletions).values([
      {
        id: newId(),
        userId: userA,
        setId: 1,
        setName: 'Alpha',
        grade: 'S',
        tokens: 100,
        completedAt: new Date('2024-05-01T10:00:00Z'),
      },
      {
        id: newId(),
        userId: userA,
        setId: 2,
        setName: 'Beta',
        grade: 'A',
        tokens: 50,
        completedAt: new Date('2024-05-03T10:00:00Z'),
      },
      {
        id: newId(),
        userId: userA,
        setId: 3,
        setName: 'Undone',
        grade: 'B',
        tokens: 999,
        completedAt: new Date('2024-05-02T10:00:00Z'),
        undoneAt: new Date('2024-05-04T10:00:00Z'),
      },
      {
        id: newId(),
        userId: userB,
        setId: 10,
        setName: 'Gamma',
        grade: null,
        tokens: 25,
        completedAt: new Date('2024-05-05T10:00:00Z'),
      },
    ]);

    await app.db.insert(userGalleryOwned).values([
      { userId: userA, resourceId: 1001, firstSeenAt: new Date('2024-04-28T09:00:00Z') },
      { userId: userA, resourceId: 1002, firstSeenAt: new Date('2024-04-29T09:00:00Z') },
      { userId: userA, resourceId: 1003, firstSeenAt: new Date('2024-04-30T09:00:00Z') },
      { userId: userB, resourceId: 2001, firstSeenAt: new Date('2024-05-04T09:00:00Z') },
      { userId: userC, resourceId: 3001, firstSeenAt: new Date('2024-04-01T09:00:00Z') },
    ]);

    await app.db.insert(userGallery).values({
      id: newId(),
      userId: userA,
      state: { cards: [], budget: 100_000, spent: 5_000 },
    });

    return { userA, userB, userC };
  }

  it('aggregates per-user totals across the three Gallery tables, excluding undone Sets', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'g-admin1@example.com');
    const { userA, userC } = await seed();

    const res = await app.inject({
      method: 'GET',
      url: GALLERY_URL,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Most Sets first: A (2) before B (1) before C (0).
    expect(body.items).toHaveLength(3);
    const a = body.items[0];
    expect(a.userId).toBe(userA);
    expect(a.email).toBe('gallery-a@example.com');
    expect(a.setsCompleted).toBe(2); // the undone Set is excluded
    expect(a.tokensEarned).toBe(150); // 100 + 50, not the undone 999
    expect(a.coinsSpent).toBe(5_000);
    expect(a.coinsBudget).toBe(100_000);
    expect(a.cardsCollected).toBe(3);
    expect(a.firstCardAt).toMatch(/^2024-04-28/);
    expect(a.firstCompletedAt).toMatch(/^2024-05-01/);
    expect(a.lastCompletedAt).toMatch(/^2024-05-03/);

    // C has a clubbed card but no completion and no saved list.
    const c = body.items[2];
    expect(c.userId).toBe(userC);
    expect(c.setsCompleted).toBe(0);
    expect(c.tokensEarned).toBe(0);
    expect(c.coinsSpent).toBe(0);
    expect(c.cardsCollected).toBe(1);
    expect(c.firstCompletedAt).toBeNull();
    expect(c.lastCompletedAt).toBeNull();

    expect(body.totals).toEqual({
      users: 3,
      setsCompleted: 3, // 2 + 1 + 0
      tokensEarned: 175, // 150 + 25
      coinsSpent: 5_000,
      cardsCollected: 5, // 3 + 1 + 1
    });
  });

  it('returns an empty list and zeroed totals when no one has used Gallery', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'g-admin-empty@example.com');
    const res = await app.inject({
      method: 'GET',
      url: GALLERY_URL,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.totals).toEqual({
      users: 0,
      setsCompleted: 0,
      tokensEarned: 0,
      coinsSpent: 0,
      cardsCollected: 0,
    });
  });

  it("a user's completed-Set log is newest-first and excludes undone Sets by default", async () => {
    const { token } = await createAdmin(app, 'super_admin', 'g-admin2@example.com');
    const { userA } = await seed();

    const res = await app.inject({
      method: 'GET',
      url: `${GALLERY_URL}/${userA}/completions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { name: string }) => i.name)).toEqual(['Beta', 'Alpha']);
    expect(body.items[0]).toMatchObject({ setId: 2, grade: 'A', tokens: 50 });
    expect(body.items[1]).toMatchObject({ setId: 1, grade: 'S', tokens: 100 });
  });

  it('undone=include surfaces undone Sets in the log', async () => {
    const { token } = await createAdmin(app, 'super_admin', 'g-admin3@example.com');
    const { userA } = await seed();

    const res = await app.inject({
      method: 'GET',
      url: `${GALLERY_URL}/${userA}/completions?undone=include`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(3);
    const undone = body.items.find((i: { setId: number }) => i.setId === 3);
    expect(undone.undoneAt).not.toBeNull();
  });

  it('a role without analytics.read (support) is forbidden', async () => {
    const { token } = await createAdmin(app, 'support', 'g-support@example.com');
    const res = await app.inject({
      method: 'GET',
      url: GALLERY_URL,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('unauthenticated requests are rejected', async () => {
    const res = await app.inject({ method: 'GET', url: GALLERY_URL });
    expect(res.statusCode).toBe(401);
  });
});
