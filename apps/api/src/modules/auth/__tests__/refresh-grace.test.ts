// The refresh grace (docs/04-auth.md §3, `REFRESH_ROTATION_GRACE_MS`): a
// refresh token presented again shortly after it was rotated, whose
// successor nobody has used, is a client retrying a refresh whose answer it
// never got (a 502 while the API restarts, a dropped connection) — it gets a
// fresh pair for the same family instead of having the family revoked. Out
// of the window, after the successor was used, or once the family was
// revoked for any reason, reuse detection is exactly what it was.
//
// "Time passing" is a backdated `revoked_at` on the rotated row, never a
// sleep or a fake clock: the window is measured from that column.

import { sessions } from '@sl/db';
import { resetDatabase } from '@sl/db/test-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import { fastHash } from '../../../lib/crypto.js';
import { REFRESH_ROTATION_GRACE_MS } from '../../../lib/tokens.js';

import type { FastifyInstance } from 'fastify';

const TEST_PW = 'correcthorsebattery12';
const NEW_PW = 'brandnewpassword12';

const device = {
  fingerprint: 'test-fingerprint-grace-0000001',
  name: 'Test Device',
  browser: 'chrome',
  os: 'linux',
  extensionVersion: '1.0.0',
};

let ipCounter = 100;
function nextIp(): string {
  ipCounter += 1;
  return `192.0.2.${ipCounter % 254}`;
}

function extractToken(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No token found in email:\n${html}`);
  return decodeURIComponent(match[1]!);
}

describe('auth module — refresh grace for a lost answer', () => {
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
    app.mailer.sentEmails.length = 0;
  });

  async function signIn(email: string, ip: string) {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: ip,
      payload: { email, password: TEST_PW, device, acceptTerms: true },
    });
    expect(registerRes.statusCode).toBe(201);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: ip,
      payload: { token: extractToken(app.mailer.sentEmails.at(-1)!.html) },
    });
    expect(verifyRes.statusCode).toBe(200);
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: ip,
      payload: { email, password: TEST_PW, device },
    });
    expect(loginRes.statusCode).toBe(200);
    const body = loginRes.json() as { accessToken: string; refreshToken: string };
    return { ...body, userId: registerRes.json().userId as string };
  }

  function refresh(ip: string, presented: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      remoteAddress: ip,
      headers,
      payload: { refreshToken: presented },
    });
  }

  /** Moves the moment `presented` was rotated `ms` into the past. */
  async function rotatedAgo(presented: string, ms: number) {
    const where = eq(sessions.refreshTokenHash, fastHash(presented));
    const row = await app.db.query.sessions.findFirst({ where });
    expect(row?.revokedReason).toBe('rotated');
    await app.db
      .update(sessions)
      .set({ revokedAt: new Date(row!.revokedAt!.getTime() - ms) })
      .where(where);
  }

  async function liveSessions(userId: string) {
    return app.db.query.sessions.findMany({
      where: and(eq(sessions.userId, userId), isNull(sessions.revokedAt)),
    });
  }

  it('a retry of a just-rotated token gets a fresh pair in the same family; the successor it never received is retired', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-retry@example.com', ip);

    const first = await refresh(ip, rt1);
    expect(first.statusCode).toBe(200);
    const lost = first.json().refreshToken as string; // the answer that never arrived

    const retry = await refresh(ip, rt1);
    expect(retry.statusCode).toBe(200);
    const { refreshToken: rt3, accessToken } = retry.json() as {
      refreshToken: string;
      accessToken: string;
    };
    expect(rt3).not.toBe(lost);
    expect(rt3).not.toBe(rt1);

    // One live session, in the family the sign-in started.
    const all = await app.db.query.sessions.findMany({ where: eq(sessions.userId, userId) });
    expect(new Set(all.map((s) => s.familyId)).size).toBe(1);
    const live = await liveSessions(userId);
    expect(live).toHaveLength(1);
    expect(live[0]!.refreshTokenHash).toBe(fastHash(rt3));
    const retired = all.find((s) => s.refreshTokenHash === fastHash(lost));
    expect(retired?.revokedReason).toBe('retry_superseded');

    // The new pair works.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect((await refresh(ip, rt3)).statusCode).toBe(200);
  });

  it('a second lost answer inside the window is retried too', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-twice@example.com', ip);
    expect((await refresh(ip, rt1)).statusCode).toBe(200);
    expect((await refresh(ip, rt1)).statusCode).toBe(200);
    const third = await refresh(ip, rt1);
    expect(third.statusCode).toBe(200);
    expect(await liveSessions(userId)).toHaveLength(1);
    expect((await refresh(ip, third.json().refreshToken)).statusCode).toBe(200);
  });

  it('the retired successor is never accepted: presenting it is reuse and revokes the family', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-retired@example.com', ip);
    const lost = (await refresh(ip, rt1)).json().refreshToken as string;
    const rt3 = (await refresh(ip, rt1)).json().refreshToken as string;

    const replay = await refresh(ip, lost);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('AUTH_TOKEN_REUSED');
    expect(await liveSessions(userId)).toHaveLength(0);
    expect((await refresh(ip, rt3)).statusCode).toBe(401);
  });

  it(`the window's boundary: ${REFRESH_ROTATION_GRACE_MS / 1000}s after rotation a retry still succeeds, a moment later it is reuse`, async () => {
    const ip = nextIp();
    const inside = await signIn('grace-inside@example.com', ip);
    expect((await refresh(ip, inside.refreshToken)).statusCode).toBe(200);
    await rotatedAgo(inside.refreshToken, REFRESH_ROTATION_GRACE_MS - 2_000);
    expect((await refresh(ip, inside.refreshToken)).statusCode).toBe(200);

    const outside = await signIn('grace-outside@example.com', ip);
    const rt2 = (await refresh(ip, outside.refreshToken)).json().refreshToken as string;
    await rotatedAgo(outside.refreshToken, REFRESH_ROTATION_GRACE_MS + 1_000);
    const reuse = await refresh(ip, outside.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe('AUTH_TOKEN_REUSED');
    // The family went with it, current token included.
    expect(await liveSessions(outside.userId)).toHaveLength(0);
    expect((await refresh(ip, rt2)).statusCode).toBe(401);
  });

  it('a replay after the successor was used is reuse, even inside the window', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-used@example.com', ip);
    const rt2 = (await refresh(ip, rt1)).json().refreshToken as string;
    const rt3 = (await refresh(ip, rt2)).json().refreshToken as string;

    const replay = await refresh(ip, rt1);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('AUTH_TOKEN_REUSED');
    expect(await liveSessions(userId)).toHaveLength(0);
    expect((await refresh(ip, rt3)).statusCode).toBe(401);
  });

  it('a logged-out session is never revived by a retry inside the window', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-logout@example.com', ip);
    const rt2 = (await refresh(ip, rt1)).json().refreshToken as string;
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      remoteAddress: ip,
      payload: { refreshToken: rt2 },
    });
    expect(logout.statusCode).toBe(200);

    const retry = await refresh(ip, rt1);
    expect(retry.statusCode).toBe(401);
    expect(await liveSessions(userId)).toHaveLength(0);
  });

  it('a password change is never revived by a retry inside the window, and the refusal says why', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-password@example.com', ip);
    const { refreshToken: rt2, accessToken: at2 } = (await refresh(ip, rt1)).json() as {
      refreshToken: string;
      accessToken: string;
    };
    const change = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      remoteAddress: ip,
      headers: { authorization: `Bearer ${at2}` },
      payload: { currentPassword: TEST_PW, newPassword: NEW_PW },
    });
    expect(change.statusCode).toBe(200);

    // The extension's next refresh, with the token it holds.
    const current = await refresh(ip, rt2);
    expect(current.statusCode).toBe(401);
    expect(current.json().details).toEqual({ reason: 'password_changed' });

    // And a retry of the token rotated seconds before the change.
    const retry = await refresh(ip, rt1);
    expect(retry.statusCode).toBe(401);
    expect(retry.json().code).toBe('AUTH_TOKEN_REUSED');
    expect(await liveSessions(userId)).toHaveLength(0);
  });

  it('a family revoked by reuse detection is never revived by a retry inside the window', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-binding@example.com', ip);
    const rt2 = (await refresh(ip, rt1)).json().refreshToken as string;
    // The current token presented from another browser family: the family
    // is revoked as a stolen token (refresh-binding.test.ts).
    const stolen = await refresh(ip, rt2, {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
    });
    expect(stolen.statusCode).toBe(401);

    const retry = await refresh(ip, rt1);
    expect(retry.statusCode).toBe(401);
    expect(await liveSessions(userId)).toHaveLength(0);
  });

  it('two refreshes with one token at the same moment revoke nothing, and leave one usable token', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-concurrent@example.com', ip);

    const results = await Promise.all([refresh(ip, rt1), refresh(ip, rt1)]);
    // The second either overlapped the first (409, re-read your storage) or
    // came just after it (a retry inside the window: a fresh pair).
    for (const res of results) expect([200, 409]).toContain(res.statusCode);
    const conflicts = results.filter((r) => r.statusCode === 409);
    for (const res of conflicts) expect(res.json().code).toBe('AUTH_REFRESH_CONFLICT');
    const issued = results
      .filter((r) => r.statusCode === 200)
      .map((r) => r.json().refreshToken as string);
    expect(issued.length).toBeGreaterThan(0);

    const live = await liveSessions(userId);
    expect(live).toHaveLength(1);
    const usable = issued.filter((t) => live[0]!.refreshTokenHash === fastHash(t));
    expect(usable).toHaveLength(1);
    expect((await refresh(ip, usable[0]!)).statusCode).toBe(200);
  });

  it('a refresh that loses the rotation to a concurrent one is answered 409 and revokes nothing', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-409@example.com', ip);
    const row = await app.db.query.sessions.findFirst({
      where: eq(sessions.refreshTokenHash, fastHash(rt1)),
    });
    expect(row).toBeDefined();

    // A concurrent refresh, mid-rotation: rt1's row revoked and a successor
    // inserted, not committed until the request below is waiting on the row.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const concurrent = app.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: 'rotated' })
        .where(eq(sessions.id, row!.id));
      await tx.insert(sessions).values({
        userId,
        deviceId: row!.deviceId,
        refreshTokenHash: fastHash('the-concurrent-successor'),
        familyId: row!.familyId,
        ip: row!.ip,
        userAgent: row!.userAgent,
        expiresAt: row!.expiresAt,
      });
      await gate;
    });

    const pending = refresh(ip, rt1);
    // Until the request reads rt1 as live and blocks on its row lock.
    for (let i = 0; i < 200; i++) {
      const waiting = await app.db.execute(
        sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if ((waiting as unknown as unknown[]).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await concurrent;

    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AUTH_REFRESH_CONFLICT');
    const live = await liveSessions(userId);
    expect(live).toHaveLength(1);
    expect(live[0]!.refreshTokenHash).toBe(fastHash('the-concurrent-successor'));
  });

  it('after a 409 the client can retry with the same token inside the window', async () => {
    const ip = nextIp();
    const { refreshToken: rt1, userId } = await signIn('grace-after-conflict@example.com', ip);
    // Whatever the two concurrent attempts got, the stored token (rt1, if
    // neither answer was kept) still works inside the window.
    await Promise.all([refresh(ip, rt1), refresh(ip, rt1)]);
    const retry = await refresh(ip, rt1);
    expect(retry.statusCode).toBe(200);
    expect(await liveSessions(userId)).toHaveLength(1);
  });
});
