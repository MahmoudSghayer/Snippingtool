// QA suite (owned by the Testing & QA agent — see docs/12-testing.md).
// Integration coverage for the notifications module (apps/api/src/modules/
// notifications), previously untested: list (cursor pagination, newest
// first, scoped to the authenticated user), mark-one-read, and
// mark-all-read.

import { notifications } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../../lib/ids.js';
import { bearer, buildTestApp, createUserSession, type TestApp } from '../helpers.js';

describe('notifications flow', () => {
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

  async function seedNotifications(userId: string, count: number) {
    const rows = Array.from({ length: count }, (_, i) => ({
      id: newId(),
      userId,
      type: 'subscription_changed',
      title: `Notification ${i}`,
      body: null,
      data: {},
      createdAt: new Date(Date.now() - i * 1000), // newest first once inserted
    }));
    await app.db.insert(notifications).values(rows);
    return rows;
  }

  it('lists only the authenticated user notifications, newest first, paginated by cursor', async () => {
    const userA = await createUserSession(app, 'notif-a@example.com', 'fp-notif-a-0000000000000001');
    const userB = await createUserSession(app, 'notif-b@example.com', 'fp-notif-b-0000000000000002');

    await seedNotifications(userA.userId, 5);
    await seedNotifications(userB.userId, 3);

    const page1 = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=2', headers: bearer(userA.accessToken) });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json() as { items: Array<{ title: string }>; nextCursor: string | null };
    expect(page1Body.items).toHaveLength(2);
    expect(page1Body.items[0]!.title).toBe('Notification 0'); // newest first
    expect(page1Body.nextCursor).not.toBeNull();

    const page2 = await app.inject({ method: 'GET', url: `/api/v1/notifications?limit=2&cursor=${page1Body.nextCursor}`, headers: bearer(userA.accessToken) });
    const page2Body = page2.json() as { items: Array<{ title: string }> };
    expect(page2Body.items.map((n) => n.title)).toEqual(['Notification 2', 'Notification 3']);

    // Never leaks userB's rows into userA's list.
    const allForA = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=50', headers: bearer(userA.accessToken) });
    const allForABody = allForA.json() as { items: Array<{ title: string }> };
    expect(allForABody.items).toHaveLength(5);
  });

  it('marks a single notification read, scoped to the owner (404 for someone else's notification)', async () => {
    const userA = await createUserSession(app, 'notif-mark-a@example.com', 'fp-notif-mark-a-000000000001');
    const userB = await createUserSession(app, 'notif-mark-b@example.com', 'fp-notif-mark-b-000000000002');
    const [rowA] = await seedNotifications(userA.userId, 1);

    const crossOwnerAttempt = await app.inject({ method: 'POST', url: `/api/v1/notifications/${rowA!.id}/read`, headers: bearer(userB.accessToken) });
    expect(crossOwnerAttempt.statusCode).toBe(404);

    const ownRead = await app.inject({ method: 'POST', url: `/api/v1/notifications/${rowA!.id}/read`, headers: bearer(userA.accessToken) });
    expect(ownRead.statusCode).toBe(200);
    expect(ownRead.json()).toEqual({ ok: true });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: bearer(userA.accessToken) });
    const body = listed.json() as { items: Array<{ id: string; readAt: string | null }> };
    expect(body.items.find((n) => n.id === rowA!.id)?.readAt).not.toBeNull();
  });

  it('marks every unread notification read for the authenticated user only', async () => {
    const userA = await createUserSession(app, 'notif-all-a@example.com', 'fp-notif-all-a-0000000000001');
    const userB = await createUserSession(app, 'notif-all-b@example.com', 'fp-notif-all-b-0000000000002');
    await seedNotifications(userA.userId, 4);
    const [bRow] = await seedNotifications(userB.userId, 1);

    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers: bearer(userA.accessToken) });
    expect(res.statusCode).toBe(200);

    const listA = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=50', headers: bearer(userA.accessToken) });
    const bodyA = listA.json() as { items: Array<{ readAt: string | null }> };
    expect(bodyA.items.every((n) => n.readAt !== null)).toBe(true);

    // userB's notification is untouched by userA's read-all.
    const listB = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: bearer(userB.accessToken) });
    const bodyB = listB.json() as { items: Array<{ id: string; readAt: string | null }> };
    expect(bodyB.items.find((n) => n.id === bRow!.id)?.readAt).toBeNull();
  });

  it('rejects unauthenticated access', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
    expect(res.statusCode).toBe(401);
  });
});
